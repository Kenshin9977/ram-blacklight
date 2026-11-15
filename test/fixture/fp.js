// first-party: 8 MB of retained arrays
window.__fp = []; for (let i = 0; i < 1024; i++) window.__fp.push(new Array(1024).fill(i + 0.5)); // 8 MB of doubles (128 x 8 KB per MB)
