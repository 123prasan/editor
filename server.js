const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");

/* ==========================================================================
   1. DATABASE MODELS
   ========================================================================== */

// --- User Schema ---
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // NOTE: In production, use bcrypt to hash this!
    name: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// --- Room Schema ---
const roomSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: { type: String, default: "Untitled Session" },
    language: { type: String, default: "javascript" },
    accessLevel: { type: String, default: "edit" }, 
    isPrivate: { type: Boolean, default: false },
    password: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    content: { type: String, default: "" },
    version: { type: Number, default: 0 },
    lastActive: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});
const Room = mongoose.model('Room', roomSchema);

/* ==========================================================================
   2. CONFIGURATION & MIDDLEWARE
   ========================================================================== */

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// Connect DB
mongoose.connect("mongodb://127.0.0.1:27017/collabcode_pro")
    .then(() => console.log("✅ MongoDB connected successfully"))
    .catch(err => console.error("❌ MongoDB connection error:", err));

// --- Auth Middleware ---
const requireAuth = async (req, res, next) => {
    const userId = req.headers['authorization'];
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

/* ==========================================================================
   3. API ROUTES (REST)
   ========================================================================== */

app.get("/", (req, res) => res.render("index"));
app.get("/room/:id", (req, res) => res.render("room", { roomid: req.params.id }));

// --- Auth Endpoints ---
app.post("/api/auth/signup", async (req, res) => {
    try {
        const { email, password, name } = req.body;
        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ error: "Email already in use" });

        const user = await User.create({ email, password, name });
        res.json({ user: { id: user._id, name: user.name, email: user.email } });
    } catch (e) { res.status(500).json({ error: "Signup failed" }); }
});

app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email, password });
        if (!user) return res.status(400).json({ error: "Invalid credentials" });
        res.json({ user: { id: user._id, name: user.name, email: user.email } });
    } catch (e) { res.status(500).json({ error: "Login failed" }); }
});

// --- Dashboard Endpoints ---
app.get("/api/dashboard", requireAuth, async (req, res) => {
    try {
        const rooms = await Room.find({ ownerId: req.user._id }).sort({ createdAt: -1 });
        const now = new Date();
        const roomData = rooms.map(r => ({
            id: r.roomId,
            name: r.name,
            language: r.language,
            access: r.accessLevel,
            status: (r.expiresAt && r.expiresAt < now) ? 'expired' : 'active',
            createdAt: r.createdAt
        }));
        res.json({ rooms: roomData });
    } catch (e) { res.status(500).json({ error: "Failed to fetch dashboard" }); }
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

        await Room.create({
            roomId,
            ownerId: req.user._id,
            name: name || "Untitled Session",
            language,
            accessLevel,
            isPrivate: !!isPrivate,
            password: password || null,
            expiresAt,
            content: "",
            version: 0
        });

        // Initialize Hot Memory
        roomState[roomId] = {
            content: "", version: 0, language,
            expiry: expiresAt ? expiresAt.toISOString() : null,
            accessLevel: accessLevel
        };

        res.json({ id: roomId });
    } catch (e) { console.error(e); res.status(500).json({ error: "Creation failed" }); }
});

/* ==========================================================================
   4. WEBSOCKET SERVER (REAL-TIME ENGINE)
   ========================================================================== */

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const roomState = {}; 



io.on("connection", (socket) => {

    /* ---- JOIN & HYDRATE ---- */
    socket.on("join_room", async (roomId) => {
        socket.join(roomId);
        socket.roomId = roomId;

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
                    ownerId: room.ownerId
                };
            } else {
                roomState[roomId] = { content: "", version: 0, language: "javascript", expiry: null, accessLevel: 'edit', users: [], ownerId: null };
            }
        }

        const state = roomState[roomId];
        let effectiveAccess = state.accessLevel;
        let isTimeBounded = false;
        let remainingSeconds = null;

        if (state.expiry && new Date(state.expiry) < new Date()) {
            effectiveAccess = 'view';
        } else if (state.expiry) {
            isTimeBounded = true;
            remainingSeconds = Math.max(0, Math.floor((new Date(state.expiry) - new Date()) / 1000));
        }

        // Track user
        const user = { id: socket.id, username: `User-${socket.id.slice(0, 5)}` };
        if (!state.users) state.users = [];
        state.users.push(user);

        socket.emit("syncSnapshot", {
            content: state.content,
            version: state.version,
            language: state.language,
            expiry: state.expiry,       
            accessLevel: effectiveAccess,
            remainingSeconds: remainingSeconds,
            isTimeBounded: isTimeBounded,
            users: state.users,
            ownerId: state.ownerId
        });

        // Notify others that user joined
        socket.to(roomId).emit("userJoined", {
            user: user,
            users: state.users,
            ownerId: state.ownerId
        });
    });

    /* ---- EDITOR OPS ---- */
    socket.on("editorOp", ({ roomId, changes, baseVersion }) => {
        const state = roomState[roomId];
        if (!state) return;

        if (state.expiry && new Date(state.expiry) < new Date()) {
            socket.emit("resync", { ...state, accessLevel: 'view' });
            return;
        }

        state.content = applyChanges(state.content, changes);
        state.version++;

        socket.emit("ack", { version: state.version });
        socket.to(roomId).emit("editorOp", { changes, version: state.version });
    });

    /* ---- LANGUAGE ---- */
    socket.on("languageChange", async ({ roomId, language }) => {
        if (!roomState[roomId]) return;
        if (roomState[roomId].expiry && new Date(roomState[roomId].expiry) < new Date()) return;

        roomState[roomId].language = language;
        socket.to(roomId).emit("languageUpdate", language);
        await Room.updateOne({ roomId }, { language });
    });

    /* ---- CURSOR & SELECTION (UPDATED) ---- */
    socket.on("cursorMove", (data) => {
        socket.to(data.roomId).emit("cursorUpdate", { userId: socket.id, position: data.position });
    });

    socket.on("selectionChange", (data) => {
        socket.to(data.roomId).emit("selectionUpdate", { userId: socket.id, selection: data.selection });
    });

    // **NEW: Broadcast Selection Clear**
    socket.on("selectionClear", ({ roomId }) => {
        socket.to(roomId).emit("selectionClear", socket.id);
    });

    /* ---- DISCONNECT ---- */
    socket.on("disconnect", async () => {
        const roomId = socket.roomId;
        if (!roomId) return;

        // Remove user from room state
        if (roomState[roomId] && roomState[roomId].users) {
            const user = roomState[roomId].users.find(u => u.id === socket.id);
            if (user) {
                roomState[roomId].users = roomState[roomId].users.filter(u => u.id !== socket.id);
                socket.to(roomId).emit("userLeft", {
                    userId: socket.id,
                    username: user.username,
                    users: roomState[roomId].users,
                    ownerId: roomState[roomId].ownerId
                });
            }
        }

        socket.to(roomId).emit("userDisconnected", socket.id);

        const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        if (roomSize === 0 && roomState[roomId]) {
            await saveRoomToDB(roomId);
            delete roomState[roomId];
        }
    });
});

/* ==========================================================================
   5. HELPERS
   ========================================================================== */

setInterval(async () => {
    for (const roomId in roomState) await saveRoomToDB(roomId);
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