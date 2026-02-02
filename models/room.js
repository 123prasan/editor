// models/Room.js
const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    
    // --- ADD THIS FIELD ---
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, 
    
    content: { type: String, default: "" },
    language: { type: String, default: "javascript" },
    version: { type: Number, default: 0 },
    name: { type: String, default: "Untitled Room" },
    accessLevel: { type: String, enum: ['edit', 'view'], default: 'edit' },
    isPrivate: { type: Boolean, default: false },
    password: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});

// Auto-delete index for expiring rooms
roomSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Room', roomSchema);