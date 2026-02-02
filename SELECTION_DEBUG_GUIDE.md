# Selection & Clear - Debugging Guide

## ✅ Changes Made

### 1. Fixed `updateSelection()` method
**Problem**: Used `inlineClassName` which doesn't work with Monaco Range decorations
**Fix**: Changed to `className` (correct decoration option)

```javascript
// BEFORE (❌ Wrong)
options: { inlineClassName: `sel-${userId}` }

// AFTER (✅ Correct)
options: { 
    className: `sel-${userId}`,
    isWholeLine: false,
    glyphMarginClassName: `gm-sel-${userId}`
}
```

### 2. Added Blur Event Handler
**Problem**: Selection wasn't being cleared when user clicked elsewhere
**Fix**: Added `onDidBlurEditorWidget` listener

```javascript
this.monaco.onDidBlurEditorWidget(() => {
    Socket.emitSelectionClear();
});
```

### 3. Enhanced Selection Change Handler
**Problem**: Selection events weren't properly logged for debugging
**Fix**: Added detailed console logging

```javascript
this.monaco.onDidChangeCursorSelection(e => {
    const sel = e.selection;
    console.log('Selection changed:', { 
        isEmpty: sel.isEmpty(), 
        startLine: sel.startLineNumber, 
        startCol: sel.startColumn, 
        endLine: sel.endLineNumber, 
        endCol: sel.endColumn 
    });
    if(sel.isEmpty()) {
        Socket.emitSelectionClear();
    } else {
        Socket.emitSelection(sel);
    }
});
```

### 4. Added Debugging Logs
All socket events now have console output:

```javascript
// Client sending
📤 Emitting selection: {startLine: 5, startCol: 10, endLine: 5, endCol: 25}
📤 Emitting selection clear

// Client receiving
✏️ Selection update from socket-xyz: {startLineNumber: 5, startColumn: 10, ...}
✂️ Selection clear from socket-xyz
🎯 Selection updated for socket-xyz: {startLine: 5, startCol: 10, ...}
🗑️ Clearing selection for socket-xyz
```

---

## 🧪 Testing Steps

### Test 1: Local Selection Clear
1. Open DevTools (F12) → Console tab
2. In your editor, select some text
3. Expected logs:
   ```
   Selection changed: {isEmpty: false, startLine: 1, ...}
   📤 Emitting selection: {startLine: 1, ...}
   ```
4. Click elsewhere in editor (or press Escape)
5. Expected logs:
   ```
   Selection changed: {isEmpty: true, ...}
   📤 Emitting selection clear
   ```

### Test 2: Remote Selection Display (2 Browsers)
1. **Browser A**: Open DevTools Console
2. **Browser B**: Same room
3. **Browser A**: Select text
4. **Browser A** should log:
   ```
   📤 Emitting selection: {startLine: ..., endLine: ...}
   ```
5. **Browser B** should log:
   ```
   ✏️ Selection update from socket-xxx: {startLineNumber: ..., endLineNumber: ...}
   🎯 Selection updated for socket-xxx: {...}
   ```
6. **Browser B** should see the selected text highlighted in a color

### Test 3: Remote Selection Clear (2 Browsers)
1. **Browser A**: Select text (see selection appear in B)
2. **Browser A**: Click elsewhere to deselect
3. **Browser A** should log:
   ```
   📤 Emitting selection clear
   ```
4. **Browser B** should log:
   ```
   ✂️ Selection clear from socket-xxx
   🗑️ Clearing selection for socket-xxx
   ```
5. **Browser B**: Selection highlighting should disappear

---

## 🔍 Troubleshooting Checklist

| Issue | Symptom | Solution |
|-------|---------|----------|
| Selection doesn't appear | Text highlighted locally but not in other user | Check if socket event reaches other user (see logs) |
| Selection won't clear | Selection stays highlighted after clicking | Check if blur handler fires (watch for "Selection changed: {isEmpty: true}") |
| Selection appears as solid highlight | Looks like Monaco selection, not custom highlight | Check CSS `.sel-{userId}` color is different |
| Multiple selections overlap | Can't tell which user's selection | Each user should have unique color (check CSS generation) |
| Selection decorations persist after user leaves | Old selection stays visible | Check `removeUser()` is called (watch "User Left" log) |

---

## 📋 Console Output Reference

### ✅ Healthy Flow (Local → Remote)

```
[LOCAL USER SELECTS TEXT]
Selection changed: {isEmpty: false, startLine: 1, startColumn: 5, endLine: 1, endColumn: 25}
📤 Emitting selection: {startLine: 1, startColumn: 5, endLine: 1, endColumn: 25}

[REMOTE USER RECEIVES]
✏️ Selection update from socket-abc123: {startLineNumber: 1, startColumn: 5, ...}
🎯 Selection updated for socket-abc123: {startLine: 1, startColumn: 5, ...}

[LOCAL USER CLEARS SELECTION]
Selection changed: {isEmpty: true, startLine: 1, startColumn: 26, endLine: 1, endColumn: 26}
📤 Emitting selection clear

[REMOTE USER RECEIVES]
✂️ Selection clear from socket-abc123
🗑️ Clearing selection for socket-abc123
```

### ⚠️ Problem Indicators

```
[PROBLEM 1: Selection not being sent]
Selection changed: {isEmpty: false, ...}
[NO "📤 Emitting selection" log]
→ Check Socket.emitSelection() is being called

[PROBLEM 2: Remote not receiving]
[Local user sees logs but remote user doesn't]
→ Check server is broadcasting properly
→ Check socket.on('selectionUpdate') is registered

[PROBLEM 3: Selection appears but won't clear]
Selection changed: {isEmpty: true, ...}
[NO "📤 Emitting selection clear" log]
→ Check if Socket.emitSelectionClear() function exists
→ Check blur handler is registered

[PROBLEM 4: Decoration not showing]
🎯 Selection updated for socket-xyz: {...}
[But no highlighting visible]
→ Check if `.sel-{userId}` CSS class was created
→ Check if color.transparent is valid CSS
→ Check range values are correct
```

---

## 🎨 CSS Debugging

### View Generated Styles
```javascript
// In browser console:
document.getElementById('style-USER_ID').innerHTML
```

### Expected CSS Output
```css
.sel-abc123def { background-color: hsla(45, 75%, 60%, 0.25) !important; }
```

### Test CSS Directly
```javascript
// In browser console:
const style = document.createElement('style');
style.innerHTML = `.test-sel { background-color: hsla(120, 75%, 60%, 0.25) !important; }`;
document.head.appendChild(style);

// Then manually create decoration with className: 'test-sel'
```

---

## 🔧 Advanced Debugging

### Monitor All Socket Events
```javascript
// Paste in browser console
const originalEmit = Socket.io.emit;
const originalOn = Socket.io.on;

Socket.io.emit = function(event, data) {
    console.log('📡 EMIT:', event, data);
    return originalEmit.call(this, event, data);
};

Socket.io.on = function(event, handler) {
    const wrappedHandler = function(data) {
        console.log('📡 RECV:', event, data);
        return handler.call(this, data);
    };
    return originalOn.call(this, event, wrappedHandler);
};
```

### Check Decoration State
```javascript
// In browser console (after selection appears)
console.log('Remote selections:', Editor.remoteSelections);
console.log('Remote cursors:', Editor.remoteCursors);

// Get all decorations
const decorations = Editor.monaco.getModel().getAllDecorations();
console.log('All decorations:', decorations);

// Find selection decorations only
decorations.filter(d => d.options.className?.includes('sel-'))
```

### Force Test
```javascript
// Manually trigger selection update
const testSel = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 10 };
Editor.updateSelection('test-user-id', testSel);

// Should see:
// 1. 🎯 Selection updated log
// 2. CSS style-test-user-id created
// 3. Text highlighted with semi-transparent color
```

---

## 🚀 How to Verify Fix

1. **Open DevTools** (F12)
2. **Go to Console tab**
3. **Open 2 browser windows** with same room
4. **In Window A**: Select text
5. **Watch Console**:
   - Window A: See "📤 Emitting selection" log
   - Window B: See "✏️ Selection update" and "🎯 Selection updated" logs
6. **In Window B**: Text should be highlighted in a different color
7. **In Window A**: Click to deselect
8. **Watch Console**:
   - Window A: See "📤 Emitting selection clear" log
   - Window B: See "✂️ Selection clear" and "🗑️ Clearing selection" logs
9. **In Window B**: Highlighting should disappear

---

## 📞 If Still Not Working

Check these in order:

1. **Selection events firing locally?**
   ```
   Type in editor, select text, watch console for "Selection changed" logs
   ```

2. **Socket events being sent?**
   ```
   Watch for "📤 Emitting selection" and "📤 Emitting selection clear"
   ```

3. **Socket events being received?**
   ```
   Check other browser console for "✏️ Selection update" or "✂️ Selection clear"
   ```

4. **Decorations being created?**
   ```
   console.log(Editor.remoteSelections) should show non-empty object
   ```

5. **CSS styling exists?**
   ```
   Check document.getElementById('style-USER_ID') returns valid style
   ```

If decorations exist but not visible, the issue is CSS - the className style isn't being applied properly by Monaco.

