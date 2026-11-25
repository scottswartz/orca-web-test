// Copy and save for the Calibration Export dialog (CalibrationExportForm).

// Copies text to the clipboard. Needs a secure context (https or localhost).
export function copyText(text) {
    return navigator.clipboard.writeText(text);
}

// Saves text as a file through the browser's download.
export function saveFile(fileName, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
