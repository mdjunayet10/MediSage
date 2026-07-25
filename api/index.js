import "dotenv/config";
import { createVercelApp } from "../server/src/vercelApp.js";

let appPromise;

async function getApp() {
  if (!appPromise) {
    appPromise = createVercelApp().then((created) => created.app);
  }
  return appPromise;
}

export default async function handler(request, response) {
  const app = await getApp();
  return app(request, response);
}
