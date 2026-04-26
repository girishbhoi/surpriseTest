import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { app } from "./app.js";

setGlobalOptions({ region: "us-central1", maxInstances: 5 });

export const api = onRequest({ cors: true }, app);
