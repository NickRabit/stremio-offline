// Stands in for the local server: the child lives on and never reports an address, the way a
// deadlocked server does.
setInterval(() => {}, 1 << 30);
