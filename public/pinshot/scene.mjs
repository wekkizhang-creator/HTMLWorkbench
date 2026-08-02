export function drawDesktopScene(ctx, { width, height, offsetX = 0, offsetY = 0 }) {
  ctx.save();
  ctx.translate(-offsetX, -offsetY);
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#10151D");
  background.addColorStop(1, "#243345");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  const windows = [
    { x: width * .07, y: height * .16, w: Math.max(360, width * .32), h: height * .54, title: "项目备忘" },
    { x: width * .45, y: height * .10, w: width * .49, h: height * .66, title: "设计评审" }
  ];
  for (const item of windows) {
    ctx.fillStyle = "#F6F7F9";
    ctx.fillRect(item.x, item.y, item.w, item.h);
    ctx.fillStyle = "#E9EDF2";
    ctx.fillRect(item.x, item.y, item.w, 44);
    ctx.fillStyle = "#69707D";
    ctx.font = '14px "Segoe UI Variable","Microsoft YaHei UI",sans-serif';
    ctx.fillText(item.title, item.x + 16, item.y + 27);
  }
  ctx.fillStyle = "#20242B";
  ctx.font = '700 32px "Segoe UI Variable","Microsoft YaHei UI",sans-serif';
  ctx.fillText("发布前检查", windows[0].x + 28, windows[0].y + 120);
  ctx.fillStyle = "#4C8DFF";
  ctx.font = '800 58px "Segoe UI Variable",sans-serif';
  ctx.fillText("PinShot", windows[1].x + windows[1].w * .31, windows[1].y + windows[1].h * .5);
  ctx.restore();
}

const byteToHex = (value) => Math.round(value).toString(16).padStart(2, "0").toUpperCase();

export function sampleDesktopSceneColor(documentRef, { x, y, width, height }) {
  const sceneWidth = Math.max(1, Math.round(Number(width) || 1));
  const sceneHeight = Math.max(1, Math.round(Number(height) || 1));
  const surface = documentRef.createElement("canvas");
  surface.width = sceneWidth;
  surface.height = sceneHeight;
  const context = surface.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Unable to sample the PinShot scene");
  drawDesktopScene(context, { width: sceneWidth, height: sceneHeight });
  const sampleX = Math.min(sceneWidth - 1, Math.max(0, Math.floor(Number(x) || 0)));
  const sampleY = Math.min(sceneHeight - 1, Math.max(0, Math.floor(Number(y) || 0)));
  const [red, green, blue] = context.getImageData(sampleX, sampleY, 1, 1).data;
  return `#${byteToHex(red)}${byteToHex(green)}${byteToHex(blue)}`;
}
