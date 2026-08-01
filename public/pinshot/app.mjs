const app = document.querySelector("#pinshotApp");
if (!app) throw new Error("PinShot root is missing");
app.setAttribute("data-pinshot-ready", "true");
