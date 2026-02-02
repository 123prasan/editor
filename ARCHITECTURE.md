# Real-Time Collaborative Editor - Architecture Diagram

## System Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER A BROWSER                            │
├─────────────────────────────────────────────────────────────────┤
│  room.ejs - Monaco Editor                                        │
│  ├─ Editor Instance                                              │
│  ├─ Active Users Panel (shows User B, C)                        │
│  ├─ Timer Display (MM:SS)                                       │
│  ├─ Toast Container (join/leave notifications)                  │
│  └─ Input/Output Panels                                          │
└────────────────┬─────────────────────────────────┬──────────────┘
                 │                                 │
                 │ socket.io              socket.io│
                 │                                 │
    ┌────────────▼─────────────────────────────────▼──────────┐
    │                    NODEJS SERVER                         │
    ├──────────────────────────────────────────────────────────┤
    │ Express + Socket.IO Server                               │
    │ ├─ Room State Management                                 │
    │ │  └─ roomState[roomId] = {                              │
    │ │     - content                                           │
    │ │     - version                                           │
    │ │     - language                                          │
    │ │     - expiry                                            │
    │ │     - users []                                          │
    │ │     - ownerId                                           │
    │ │  }                                                       │
    │ │                                                          │
    │ ├─ Socket Handlers                                        │
    │ │  ├─ join_room()                                         │
    │ │  ├─ editorOp()                                          │
    │ │  ├─ languageChange()                                    │
    │ │  ├─ cursorMove()                                        │
    │ │  ├─ selectionChange()                                   │
    │ │  ├─ selectionClear()  ← FIXED                           │
    │ │  └─ disconnect()                                        │
    │ │                                                          │
    │ ├─ Broadcast Intervals                                    │
    │ │  ├─ Timer Update (every 1 second)                       │
    │ │  │  └─ Check expiry & emit timerUpdate                  │
    │ │  │  └─ If expired: emit roomTimeUp + cleanup            │
    │ │  └─ Auto-save (every 5 seconds)                         │
    │ │     └─ Save roomState to MongoDB                        │
    │ │                                                          │
    │ └─ Database Integration                                   │
    │    ├─ MongoDB Collections                                 │
    │    ├─ Room Schema                                         │
    │    └─ Auto-save on changes                                │
    │                                                            │
    └────────┬────────────────┬──────────────┬──────────────────┘
             │                │              │
      ┌──────▼──────┐  ┌──────▼──────┐  ┌──▼────────────┐
      │   USER B    │  │   USER C    │  │  USER D       │
      │  Browser    │  │  Browser    │  │  Browser      │
      │  room.ejs   │  │  room.ejs   │  │  room.ejs     │
      └─────────────┘  └─────────────┘  └───────────────┘
```

---

## Socket Event Flow

### 1. USER JOIN SEQUENCE

```
User A                          Server                    User B
  │                              │                          │
  ├─ socket.io connect           │                          │
  │                              │                          │
  ├─ join_room(roomId) ──────────▶                          │
  │                              │                          │
  │◀─ syncSnapshot ───────────────┤                          │
  │  (content, version, language, │                          │
  │   timer, users, ownerId)      │                          │
  │                              │                          │
  │                              ├─ userJoined ───────────▶ │
  │                              │  (user, users, ownerId)   │
  │                              │                          │
  │  ┌──────────────────┐       │                          │
  │  │ Update UI:       │       │                          │
  │  │ - Show User B    │       │                          │
  │  │ - Update timer   │       │                          │
  │  │ - Show code      │       │                          │
  │  └──────────────────┘       │                          │
  │                              │  ┌───────────────────┐   │
  │                              │  │ Update UI:        │   │
  │                              │  │ - Show User A     │   │
  │                              │  │ - Toast: A joined │   │
  │                              │  └───────────────────┘   │
```

### 2. CODE EDIT SEQUENCE

```
User A                          Server                    User B
  │                              │                          │
  │ [Types code]                 │                          │
  │                              │                          │
  ├─ editorOp ───────────────────▶                          │
  │  (changes, baseVersion)       │                          │
  │                              │                          │
  │◀─ ack ────────────────────────┤                          │
  │  (version)                    │                          │
  │                              │                          │
  │  [Local update shown]        │◀─ editorOp ─────────────┤
  │                              │  (changes, version)      │
  │                              │                          │
  │                              │  [Apply changes]         │
```

### 3. SELECTION SEQUENCE

```
User A                          Server                    User B
  │                              │                          │
  │ [Selects text]               │                          │
  │                              │                          │
  ├─ selectionChange ────────────▶                          │
  │  (roomId, selection)          │                          │
  │                              │                          │
  │                              ├─ selectionUpdate ──────▶ │
  │                              │  (userId, selection)     │
  │                              │                          │
  │                              │  [Show selection]        │
  │                              │                          │
  │ [Clicks elsewhere]            │                          │
  │                              │                          │
  ├─ selectionClear ─────────────▶                          │
  │  (roomId)                     │                          │
  │                              │                          │
  │  [Clear local selection]     │◀─ selectionClear ──────┤
  │                              │  (userId)               │
  │                              │                          │
  │                              │  [Clear remote selection]│
```

### 4. USER DISCONNECT SEQUENCE

```
User A                          Server                    User B
  │                              │                          │
  │ [Closes tab/disconnect]       │                          │
  │                              │                          │
  ├─ disconnect ──────────────────▶                          │
  │                              │                          │
  │                              │ [Remove User A from]    │
  │                              │  roomState.users        │
  │                              │                          │
  │                              ├─ userLeft ────────────▶ │
  │                              │  (userId, username,      │
  │                              │   users, ownerId)        │
  │                              │                          │
  │                              │  ┌───────────────────┐   │
  │                              │  │ Update UI:        │   │
  │                              │  │ - Remove User A   │   │
  │                              │  │ - Toast: A left   │   │
  │                              │  └───────────────────┘   │
  │                              │                          │
  │                              │ [If roomSize === 0]      │
  │                              │ Save to DB & cleanup     │
```

### 5. TIMER SEQUENCE

```
Every 1 second:

Server                          All Users
  │                              │
  ├─ timerUpdate ─────────────────▶
  │  (remainingSeconds,            │
  │   isTimeBounded)               │
  │                               │
  │                      [Update Timer Display]
  │                      [CSS Classes: warning/danger]
  │                               │
  │ When remainingSeconds === 0:   │
  │                               │
  ├─ roomTimeUp ──────────────────▶
  │                               │
  │ [Delete room]          [Show Toast & Redirect]
  │ [Clean up data]        [Redirect to home]
```

---

## State Diagram

```
┌─────────────────────────────────────┐
│     ROOM NOT CREATED                │
│  (User on home page)                │
└────────────┬────────────────────────┘
             │
             │ User clicks "Create Room"
             │
             ▼
┌─────────────────────────────────────┐
│     ROOM CREATED                    │
│  (No users, awaiting first join)    │
│                                     │
│  roomState[roomId] = {              │
│    content: "",                     │
│    users: [],                       │
│    expiry: null or ISO8601          │
│  }                                  │
└────────────┬────────────────────────┘
             │
             │ User A joins room
             │
             ▼
┌─────────────────────────────────────┐
│     ROOM ACTIVE                     │
│  (Users connected and collaborating)│
│                                     │
│  roomState[roomId].users = [        │
│    { id: "socket1", username: "..." }│
│  ]                                  │
└────────────┬────────────────────────┘
             │
             ├─ User B joins ───┐
             │                  │
             ▼                  ▼
     ┌─────────────────────────────┐
     │  ACTIVE (2+ Users)          │
     │  Broadcasting:              │
     │  - Edits                    │
     │  - Cursors                  │
     │  - Selections               │
     │  - Timer updates            │
     └────────────┬────────────────┘
                  │
         ┌────────┼────────┐
         │                 │
         │ All disconnect  │ Time expires
         │                 │
         ▼                 ▼
    ┌─────────┐       ┌──────────┐
    │  EMPTY  │       │ EXPIRED  │
    │ (Save & │       │ (Delete& │
    │ Delete) │       │ Redirect)│
    └─────────┘       └──────────┘
         │                 │
         └────────┬────────┘
                  │
                  ▼
         ┌─────────────────┐
         │   DESTROYED     │
         │ (Cleanup)       │
         └─────────────────┘
```

---

## Data Structure Hierarchy

```
MongoDB
 └─ Room Collection
     └─ Document {
         _id: ObjectId
         roomId: "ABC123"
         ownerId: ObjectId
         name: "Project X"
         language: "javascript"
         content: "// code here"
         version: 42
         accessLevel: "edit"
         isPrivate: false
         password: null
         expiresAt: ISO8601
         createdAt: ISO8601
       }

Server Memory (roomState)
 └─ roomState {
     "ABC123": {
         content: "// code here"
         version: 42
         language: "javascript"
         expiry: ISO8601 | null
         accessLevel: "edit"
         users: [
             { id: "socket123", username: "User-abc" },
             { id: "socket456", username: "User-def" }
         ]
         ownerId: ObjectId
       }
   }

Client (Browser)
 └─ Monaco Editor {
     value: "// code here"
     language: "javascript"
   }
 └─ UI State {
     activeUsers: [...],
     currentUserId: "socket123",
     remainingSeconds: 300,
     isTimeBounded: true
   }
 └─ Decorations {
     remoteCursors: {
         "socket456": [DecorationId]
     },
     remoteSelections: {
         "socket456": [DecorationId]
     }
   }
```

---

## Console Output Examples

```javascript
// User A joins
✅ Connected to server with ID: socket-abc123
📥 Sync Snapshot received: {version: 0, language: "javascript", isTimeBounded: false, userCount: 1}
👤 User joined: User-abc

// User B joins  
✅ Connected to server with ID: socket-def456
📥 Sync Snapshot received: {version: 0, language: "javascript", isTimeBounded: false, userCount: 2}
👤 User joined: User-def
(Server broadcasts to User A)
👤 User joined: User-def

// Timer ticking (every second)
⏰ timerUpdate received: {remainingSeconds: 299, isTimeBounded: true}
⏰ timerUpdate received: {remainingSeconds: 298, isTimeBounded: true}
...

// User B's selection clears
🗑️ Selection cleared for user: socket-def456

// User B leaves
👋 User left: User-def
(UI updates: removes User B from list, shows toast)

// Timer expires
⏰ Room time is up!
(Toast shown, redirect to home in 2 seconds)
```

---

## Performance Considerations

```
Network Messages per Second (3 users, active editing):
├─ Editor Ops: ~2-5 messages/sec (throttled)
├─ Cursor Updates: ~10-20 messages/sec (debounced to 50ms)
├─ Selection Updates: ~0.5-2 messages/sec (on change)
├─ Timer Updates: 1 message/sec (from server)
└─ Total: ~15-30 messages/sec

Memory Usage (per room):
├─ Room State: ~5-50 KB (depends on code size)
├─ User List: ~200 bytes per user
├─ Socket Objects: ~1-2 KB per connection
└─ Total: ~10-100 KB per active room

Database Operations:
├─ Auto-save Interval: every 5 seconds
├─ Save Size: variable (code + metadata)
└─ Index: expiresAt for cleanup
```

---

## Error Handling

```javascript
1. User Disconnect
   ├─ Remove from users array
   ├─ Broadcast userLeft event
   ├─ Save room to DB
   └─ Cleanup memory if empty

2. Room Expiration
   ├─ Check on every timer interval
   ├─ Broadcast roomTimeUp
   ├─ Delete from memory & DB
   └─ Client redirects

3. Sync Issues
   ├─ Version mismatch → ignore
   ├─ Invalid changes → sanitize
   └─ Lost connection → auto-reconnect

4. Selection Clear
   ├─ Check if user exists
   ├─ Check if decorations exist
   ├─ Remove safely
   └─ Delete reference
```

