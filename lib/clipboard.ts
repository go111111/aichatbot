export async function writeTextToClipboard(text: string) {
  if (typeof window === "undefined") {
    throw new Error("Clipboard is not available");
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy copy path below. Some embedded browsers expose
      // the Clipboard API but deny write permission.
    }
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.appendChild(textArea);
  textArea.select();

  try {
    const copied = document.execCommand("copy");

    if (!copied) {
      throw new Error("Clipboard write permission denied");
    }
  } finally {
    document.body.removeChild(textArea);
  }
}
