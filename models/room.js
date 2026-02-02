// models/Room.js
const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    content: { type: String, default: "" },
    language: { type: String, default: "javascript" },
    version: { type: Number, default: 0 },
    
    // --- NEW CONFIGURATION FIELDS ---
    name: { type: String, default: "Untitled Room" },
    accessLevel: { type: String, enum: ['edit', 'view'], default: 'edit' },
    isPrivate: { type: Boolean, default: false },
    password: { type: String, default: null }, // Store raw or hashed (raw for simplicity now)
    expiresAt: { type: Date, default: null },   // Null = never
    createdAt: { type: Date, default: Date.now } // For cleanup logic
});

// Auto-delete index for expiring rooms
roomSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Room', roomSchema);