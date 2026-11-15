// third-party library: allocates on behalf of its caller
window.tpLib = { makeArrays(mb) { const a = []; for (let i = 0; i < mb * 128; i++) a.push(new Array(1024).fill(i + 0.5)); return a; } };
