import { options } from "preact";

// Keep passive effects inside each test environment instead of Preact's native frame timer.
options.requestAnimationFrame = queueMicrotask;
