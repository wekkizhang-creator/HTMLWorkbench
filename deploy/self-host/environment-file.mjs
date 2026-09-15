function parseValue(raw, lineNumber) {
  let value = "";
  let index = 0;
  let quote = null;
  while (index < raw.length) {
    const character = raw[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else value += character;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === "\\" && index + 1 < raw.length) {
        index += 1;
        value += raw[index];
      } else {
        value += character;
      }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "\\" && index + 1 < raw.length) {
      index += 1;
      value += raw[index];
    } else if (character === "#" && (index === 0 || /\s/.test(raw[index - 1]))) {
      break;
    } else {
      value += character;
    }
    index += 1;
  }
  if (quote) throw new Error(`Unterminated quote on environment line ${lineNumber}`);
  return value.trimEnd();
}

export function parseSystemdEnvironmentFile(contents) {
  const environment = {};
  const logicalLines = [];
  let pending = "";
  for (const physicalLine of String(contents).split(/\r?\n/)) {
    pending += physicalLine;
    let slashCount = 0;
    for (let index = pending.length - 1; index >= 0 && pending[index] === "\\"; index -= 1) slashCount += 1;
    if (slashCount % 2 === 1) {
      pending = pending.slice(0, -1);
      continue;
    }
    logicalLines.push(pending);
    pending = "";
  }
  if (pending) logicalLines.push(pending);

  for (const [index, line] of logicalLines.entries()) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Invalid environment assignment on line ${index + 1}`);
    environment[match[1]] = parseValue(match[2], index + 1);
  }
  return environment;
}
