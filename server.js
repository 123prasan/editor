const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");

/* ==========================================================================
   1. DATABASE MODELS
   ========================================================================== */

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const roomSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, default: "Untitled Session" },
    language: { type: String, default: "javascript" },
    accessLevel: { type: String, default: "edit" },
    isPrivate: { type: Boolean, default: false },
    password: { type: String, default: null },
    expiresAt: { type: Date, default: null, expires: 0 },
    content: { type: String, default: "" },
    version: { type: Number, default: 0 },
    bannedUsers: [{ type: String }], // Track Banned User IDs
    lastActive: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});
const Room = mongoose.model('Room', roomSchema);

/* ==========================================================================
   2. CONFIGURATION & MIDDLEWARE
   ========================================================================== */

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// Connect DB
mongoose.connect("mongodb://127.0.0.1:27017/collabcode_pro")
    .then(() => console.log("✅ MongoDB connected successfully"))
    .catch(err => console.error("❌ MongoDB connection error:", err));

// Global Room State (In-Memory)
const roomState = {};

// --- API Auth Middleware ---
const requireAuth = async (req, res, next) => {
    const userId = req.headers['authorization'] || req.cookies['auth_token'];
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(401).json({ error: "Invalid User" });
        req.user = user;
        next();
    } catch (e) {
        return res.status(500).json({ error: "Authentication check failed" });
    }
};

// --- Page Auth Middleware ---
const requirePageLogin = async (req, res, next) => {
    const userId = req.cookies['auth_token'];
    if (!userId) {
        const targetUrl = encodeURIComponent(req.originalUrl);
        return res.redirect(`/?next=${targetUrl}`);
    }
    try {
        const user = await User.findById(userId);
        if (!user) {
            res.clearCookie('auth_token');
            return res.redirect(`/?next=${encodeURIComponent(req.originalUrl)}`);
        }
        req.user = user;
        next();
    } catch (e) {
        return res.redirect(`/?next=${encodeURIComponent(req.originalUrl)}`);
    }
};

/* ==========================================================================
   3. API ROUTES (REST)
   ========================================================================== */

app.get("/", (req, res) => res.render("index"));

app.get("/login", (req, res) => {
    if (req.cookies['auth_token']) return res.redirect('/');
    res.render("login");
});

app.get("/room/:id", requirePageLogin, async (req, res) => {
    try {
        const room = await Room.findOne({ roomId: req.params.id });
        if (!room) return res.status(404).send("Room not found");

        const isOwner = room.ownerId.toString() === req.user._id.toString();
        const requiresPassword = room.isPrivate && !isOwner;

        // Check if banned before rendering
        if (room.bannedUsers && room.bannedUsers.includes(req.user._id.toString())) {
            return res.status(403).send("You have been banned from this room.");
        }

        res.render("room", {
            roomid: req.params.id,
            user: req.user,
            requiresPassword,
            isOwner
        });
    } catch (e) {
        res.status(500).send("Server Error");
    }
});

app.post("/api/auth/signup", async (req, res) => {
    try {
        const { email, password, name } = req.body;
        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ error: "Email already in use" });

        const user = await User.create({ email, password, name });
        res.cookie('auth_token', user._id.toString(), { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ user: { id: user._id, name: user.name, email: user.email } });
    } catch (e) { res.status(500).json({ error: "Signup failed" }); }
});

app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email, password });
        if (!user) return res.status(400).json({ error: "Invalid credentials" });

        res.cookie('auth_token', user._id.toString(), { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ user: { id: user._id, name: user.name, email: user.email } });
    } catch (e) { res.status(500).json({ error: "Login failed" }); }
});

app.get("/api/dashboard", requireAuth, async (req, res) => {
    try {
        const rooms = await Room.find({ ownerId: req.user._id }).sort({ createdAt: -1 });
        const now = new Date();
        const roomData = rooms.map(r => {
            const activeCount = roomState[r.roomId]?.users?.length || 0;
            return {
                id: r.roomId,
                name: r.name,
                language: r.language,
                access: r.accessLevel,
                status: (r.expiresAt && r.expiresAt < now) ? 'expired' : 'active',
                createdAt: r.createdAt,
                activeUsers: activeCount
            };
        });
        res.json({ rooms: roomData });
    } catch (e) { res.status(500).json({ error: "Failed to fetch dashboard" }); }
});

app.post("/api/delete_room", requireAuth, async (req, res) => {
    try {
        const { roomId } = req.body;
        const room = await Room.findOne({ roomId, ownerId: req.user._id });

        if (!room) return res.status(403).json({ error: "Not authorized or room not found" });

        await Room.deleteOne({ roomId });

        if (roomState[roomId]) {
            io.to(roomId).emit('roomDestroyed');
            io.in(roomId).disconnectSockets();
            delete roomState[roomId];
        }

        io.to('dashboard').emit('roomDeleted', { roomId });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Deletion failed" });
    }
});

app.post("/api/update_room_access", requireAuth, async (req, res) => {
    try {
        const { roomId, accessLevel } = req.body;
        const room = await Room.findOneAndUpdate(
            { roomId, ownerId: req.user._id },
            { accessLevel },
            { new: true }
        );

        if (!room) return res.status(403).json({ error: "Not authorized" });

        if (roomState[roomId]) {
            roomState[roomId].accessLevel = accessLevel;
            const sockets = await io.in(roomId).fetchSockets();
            for (const socket of sockets) {
                const isOwner = roomState[roomId].ownerId.toString() === socket.userId;
                const newAccess = isOwner ? 'edit' : accessLevel;
                socket.emit("syncSnapshot", {
                    ...roomState[roomId],
                    accessLevel: newAccess,
                    isOwner
                });
            }
        }

        io.to('dashboard').emit('roomAccessChanged', { roomId, accessLevel });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Update failed" });
    }
});

app.post("/api/create_room", requireAuth, async (req, res) => {
    try {
        const { name, language, expiry, accessLevel, isPrivate, password } = req.body;
        const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();

        let expiresAt = null;
        if (expiry && expiry !== 'never') {
            const now = new Date();
            const timeMap = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
            if (timeMap[expiry]) expiresAt = new Date(now.getTime() + timeMap[expiry]);
        }

        const newRoom = await Room.create({
            roomId,
            ownerId: req.user._id,
            name: name || "Untitled Session",
            language,
            accessLevel,
            isPrivate: !!isPrivate,
            password: password || null,
            expiresAt,
            content: "",
            version: 0,
            bannedUsers: []
        });

        roomState[roomId] = {
            content: "", version: 0, language,
            expiry: expiresAt ? expiresAt.toISOString() : null,
            accessLevel: accessLevel,
            ownerId: req.user._id,
            isPrivate: !!isPrivate,
            password: password || null,
            bannedUsers: [], 
            users: []
        };

        io.to('dashboard').emit('roomCreated', {
            id: roomId,
            name: newRoom.name,
            language: newRoom.language,
            access: newRoom.accessLevel,
            activeUsers: 0,
            status: 'active',
            ownerId: req.user._id.toString()
        });

        res.json({ id: roomId });
    } catch (e) { console.error(e); res.status(500).json({ error: "Creation failed" }); }
});

/* ==========================================================================
   4. WEBSOCKET SERVER
   ========================================================================== */

io.use((socket, next) => {
    const cookieHeader = socket.request.headers.cookie;
    if (cookieHeader) {
        const token = cookieHeader.split('; ').find(row => row.startsWith('auth_token='));
        if (token) socket.userId = token.split('=')[1];
    }
    next();
});

io.on("connection", (socket) => {

    socket.on('join_dashboard', () => socket.join('dashboard'));

    socket.on("join_room", async (data) => {
        const roomId = typeof data === 'object' ? data.roomId : data;
        const providedPassword = typeof data === 'object' ? data.password : null;

        socket.join(roomId);
        socket.roomId = roomId;

        // Initialize Room State if missing
        if (!roomState[roomId]) {
            let room = await Room.findOne({ roomId });
            if (room) {
                roomState[roomId] = {
                    content: room.content,
                    version: room.version,
                    language: room.language,
                    expiry: room.expiresAt ? room.expiresAt.toISOString() : null,
                    accessLevel: room.accessLevel,
                    users: [],
                    ownerId: room.ownerId,
                    isPrivate: room.isPrivate,
                    password: room.password,
                    bannedUsers: room.bannedUsers || []
                };
            } else {
                roomState[roomId] = { content: "", version: 0, language: "javascript", expiry: null, accessLevel: 'edit', users: [], ownerId: null };
            }
        }

        const state = roomState[roomId];
        const isOwner = state.ownerId && socket.userId && (state.ownerId.toString() === socket.userId);

        // --- BAN CHECK ---
        if (socket.userId && state.bannedUsers && state.bannedUsers.includes(socket.userId)) {
            socket.emit("error", "You have been banned from this room.");
            socket.disconnect();
            return;
        }

        // --- SECURITY CHECK ---
        if (state.isPrivate && !isOwner) {
            if (state.password !== providedPassword) {
                socket.emit("error", "Invalid Password");
                socket.disconnect();
                return;
            }
        }

        // --- FETCH USER INFO & ENFORCE SINGLE SESSION ---
        let username = `Guest-${socket.id.slice(0, 4)}`;
        let dbId = null;

        if (socket.userId) {
            const dbUser = await User.findById(socket.userId);
            if (dbUser) {
                username = dbUser.name;
                dbId = dbUser._id.toString();
            }
        }

        // Check if user is already in the room
        if (dbId) {
            const existingUser = state.users.find(u => u.dbId === dbId);
            if (existingUser) {
                // Notify & Disconnect the old socket
                io.to(existingUser.id).emit("error", "New session started in another tab.");
                const oldSocket = io.sockets.sockets.get(existingUser.id);
                if (oldSocket) oldSocket.disconnect();
                
                // Remove from state immediately to prevent duplicates
                state.users = state.users.filter(u => u.dbId !== dbId);
            }
        }

        const user = { id: socket.id, username, dbId };

        // Add to active users
        if (!state.users) state.users = [];
        state.users.push(user);

        // Determine Access Level
        let effectiveAccess = state.accessLevel;
        let isTimeBounded = false;
        let remainingSeconds = null;

        if (state.expiry) {
            if (new Date(state.expiry) < new Date()) {
                effectiveAccess = 'view';
            } else {
                isTimeBounded = true;
                remainingSeconds = Math.max(0, Math.floor((new Date(state.expiry) - new Date()) / 1000));
            }
        }
        if (isOwner) effectiveAccess = 'edit';

        // Notify Dashboard & Room
        io.to('dashboard').emit('roomUpdate', { roomId, activeUsers: state.users.length });

        // Send Snapshot to New User
        socket.emit("syncSnapshot", {
            content: state.content,
            version: state.version,
            language: state.language,
            expiry: state.expiry,
            accessLevel: effectiveAccess,
            isOwner,
            remainingSeconds,
            isTimeBounded,
            users: state.users,
            ownerId: state.ownerId
        });

        // Notify Existing Users
        socket.to(roomId).emit("userJoined", {
            user,
            users: state.users,
            ownerId: state.ownerId
        });
    });

    // --- WEBRTC SIGNALING (Fix for Video Call) ---
    // Pass 'originId' so client knows WHO sent the message
    socket.on("offer", (payload) => {
        io.to(payload.target).emit("offer", { sdp: payload.sdp, originId: socket.id });
    });

    socket.on("answer", (payload) => {
        io.to(payload.target).emit("answer", { sdp: payload.sdp, originId: socket.id });
    });

    socket.on("ice-candidate", (incoming) => {
        io.to(incoming.target).emit("ice-candidate", { candidate: incoming.candidate, originId: socket.id });
    });

    // --- KICK & BAN HANDLER ---
    socket.on('kick_user', async ({ targetSocketId }) => {
        const roomId = socket.roomId;
        if (!roomId || !roomState[roomId]) return;

        // Verify Owner
        const isOwner = roomState[roomId].ownerId && socket.userId && 
                        (roomState[roomId].ownerId.toString() === socket.userId);
        
        if (!isOwner) return;

        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (!targetSocket) return;

        // Add to Ban List
        if (targetSocket.userId) {
            if (!roomState[roomId].bannedUsers) roomState[roomId].bannedUsers = [];
            if (!roomState[roomId].bannedUsers.includes(targetSocket.userId)) {
                roomState[roomId].bannedUsers.push(targetSocket.userId);
                
                // Persist to DB
                await Room.updateOne(
                    { roomId }, 
                    { $addToSet: { bannedUsers: targetSocket.userId } }
                );
            }
        }

        // Kick
        io.to(targetSocketId).emit('kicked');
        targetSocket.disconnect();
    });

    // --- ROOM DESTRUCTION ---
    socket.on("destroy_room", async () => {
        const roomId = socket.roomId;
        if (!roomId || !roomState[roomId]) return;
        const isOwner = roomState[roomId].ownerId && socket.userId && (roomState[roomId].ownerId.toString() === socket.userId);
        if (isOwner) {
            io.to(roomId).emit("roomDestroyed");
            io.in(roomId).disconnectSockets();
            delete roomState[roomId];
            await Room.deleteOne({ roomId });
            io.to('dashboard').emit('roomExpired', { roomId });
        }
    });

    // --- EDITOR SYNC ---
    socket.on("editorOp", ({ roomId, changes, baseVersion }) => {
        const state = roomState[roomId];
        if (!state) return;
        if (state.expiry && new Date(state.expiry) < new Date()) {
            const isOwner = state.ownerId && socket.userId && (state.ownerId.toString() === socket.userId);
            if (!isOwner) {
                socket.emit("resync", { ...state, accessLevel: 'view' });
                return;
            }
        }
        state.content = applyChanges(state.content, changes);
        state.version++;
        socket.emit("ack", { version: state.version });
        socket.to(roomId).emit("editorOp", { changes, version: state.version });
    });

    socket.on("languageChange", async ({ roomId, language }) => {
        if (!roomState[roomId]) return;
        if (roomState[roomId].expiry && new Date(roomState[roomId].expiry) < new Date()) {
            const isOwner = roomState[roomId].ownerId && socket.userId && (roomState[roomId].ownerId.toString() === socket.userId);
            if (!isOwner) return;
        }
        roomState[roomId].language = language;
        socket.to(roomId).emit("languageUpdate", language);
        await Room.updateOne({ roomId }, { language });
    });

    socket.on("cursorMove", (data) => {
        socket.to(data.roomId).emit("cursorUpdate", { userId: socket.id, position: data.position });
    });

    socket.on("selectionChange", (data) => {
        socket.to(data.roomId).emit("selectionUpdate", { userId: socket.id, selection: data.selection });
    });

    socket.on("selectionClear", ({ roomId }) => {
        socket.to(roomId).emit("selectionClear", socket.id);
    });

    socket.on("disconnect", async () => {
        const roomId = socket.roomId;
        if (!roomId) return;

        if (roomState[roomId] && roomState[roomId].users) {
            roomState[roomId].users = roomState[roomId].users.filter(u => u.id !== socket.id);
            io.to('dashboard').emit('roomUpdate', { roomId, activeUsers: roomState[roomId].users.length });

            socket.to(roomId).emit("userLeft", {
                userId: socket.id,
                users: roomState[roomId].users,
                ownerId: roomState[roomId].ownerId
            });
        }
        socket.to(roomId).emit("userDisconnected", socket.id);

        const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        if (roomSize === 0 && roomState[roomId]) {
            await saveRoomToDB(roomId);
            delete roomState[roomId];
            io.to('dashboard').emit('roomUpdate', { roomId, activeUsers: 0 });
        }
    });
});

/* ==========================================================================
   5. HELPERS
   ========================================================================== */

setInterval(async () => {
    const now = new Date();
    for (const roomId in roomState) {
        if (roomState[roomId].expiry && new Date(roomState[roomId].expiry) < now) {
            io.to('dashboard').emit('roomExpired', { roomId });
            io.to(roomId).emit("roomDestroyed");
            io.in(roomId).disconnectSockets();
            delete roomState[roomId];
            await Room.deleteOne({ roomId });
            console.log(`Room ${roomId} auto-destroyed.`);
            continue;
        }
        await saveRoomToDB(roomId);
    }
}, 5000);

async function saveRoomToDB(roomId) {
    if (!roomState[roomId]) return;
    const { content, version, language } = roomState[roomId];
    try {
        await Room.updateOne({ roomId }, { content, version, language, lastActive: new Date() }, { upsert: true });
    } catch(e) { console.error("Auto-save failed", e); }
}

function applyChanges(content, changes) {
    const edits = changes.map(change => {
        const start = getIndexFromPosition(content, change.range.startLineNumber, change.range.startColumn);
        const end = getIndexFromPosition(content, change.range.endLineNumber, change.range.endColumn);
        return { start, end, text: change.text };
    }).sort((a, b) => b.start - a.start);
    let text = content;
    for (const edit of edits) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    return text;
}

function getIndexFromPosition(text, line, column) {
    const lines = text.split("\n");
    let index = 0;
    for (let i = 0; i < line - 1; i++) {
        if (lines[i] !== undefined) index += lines[i].length + 1;
    }
    return index + (column - 1);
}

server.listen(3000, () => console.log("🚀 Server running on port 3000"));