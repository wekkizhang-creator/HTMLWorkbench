import { fitPinToViewport } from "./pins.mjs";

export const PIN_VIEWPORT_ERROR = "无法在当前视口创建贴图";

export function dispatchFittedPin({ dispatch, pin, viewport, maxSize }) {
  const fittedPin = fitPinToViewport(pin, viewport, maxSize);
  if (!fittedPin) throw new Error(PIN_VIEWPORT_ERROR);
  dispatch({ type: "PIN_CREATE", pin: fittedPin });
  return fittedPin;
}
