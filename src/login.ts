#!/usr/bin/env node
// One-time setup: opens the dedicated Chrome profile on Google Vids so the user can sign in by hand.
import { getVidsPage, PROFILE_DIR } from "./chrome.js";

const page = await getVidsPage();
await page.bringToFront();
console.log(`Chrome is open on ${page.url()}`);
console.log(`Profile: ${PROFILE_DIR}`);
console.log("Sign in to Google in that window (the account that has Google Vids). The session is kept for next time.");
process.exit(0);
