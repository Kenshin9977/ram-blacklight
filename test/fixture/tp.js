// third-party: 24 MB of retained arrays (V8 heap)
window.__tp = []; for (let i = 0; i < 3072; i++) window.__tp.push(new Array(1024).fill(i + 0.5)); // 24 MB of doubles (128 x 8 KB per MB)
// third-party: 16 MB ArrayBuffer (backing store lives outside the V8 heap)
window.__tpBuf = new Uint8Array(16 * 1048576).fill(1);
// third-party: 20 000 DOM nodes (Blink/Oilpan heap, not V8)
const box = document.createElement('div'); box.style.display = 'none';
for (let i = 0; i < 20000; i++) { const d = document.createElement('div'); d.textContent = 'node ' + i; box.appendChild(d); }
document.documentElement.appendChild(box);
