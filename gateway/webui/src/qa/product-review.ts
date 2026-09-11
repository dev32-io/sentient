/** Standalone DEV entry only. Install isolation BEFORE importing any production UI. */
import { createProductReviewFetch, createReviewStorage } from "./product-review-fixtures.ts";

if (!import.meta.env.DEV) throw new Error("Product review is development-only");
const params = new URLSearchParams(location.search);
const storage = createReviewStorage();
storage.setItem("sentient:auth", JSON.stringify({ token: "fictional-review-token" }));
Object.defineProperty(window, "localStorage", { value: storage });
Object.defineProperty(window, "sessionStorage", { value: storage });
globalThis.fetch = createProductReviewFetch(params.get("state") ?? "populated", params.get("role") !== "adult");
window.open = () => null;
// Audio creation/recording is never part of this visual proof, even after clicks.
const denied = () => {
  throw new Error("Unavailable in fixture review");
};
Object.defineProperty(window, "AudioContext", { value: denied });
Object.defineProperty(window, "Audio", { value: denied });
if (navigator.mediaDevices)
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    value: async () => {
      throw new Error("Fixture review has no microphone");
    },
  });
void import("./product-review-pages.tsx");
