/**
 * Side-effect bootstrap so Sentry.init runs before the Express app module
 * evaluates. Keep this import first in index.ts.
 */
import { initSentry } from "./sentry.js";

initSentry();
