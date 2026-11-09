// Loaded on demand by Orca.Web/Services/BrowserFilePicker.cs and BrowserFileSaver.cs.

// Opens the file chooser; resolves to { name, base64 } or null if cancelled.
export function pickFile(accept) {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        if (accept) input.accept = accept;
        input.style.display = "none";
        document.body.appendChild(input);

        const cleanup = () => input.remove();

        input.addEventListener("cancel", () => {
            cleanup();
            resolve(null);
        });

        input.addEventListener("change", () => {
            const file = input.files && input.files[0];
            if (!file) {
                cleanup();
                resolve(null);
                return;
            }
            const reader = new FileReader();
            reader.onerror = () => {
                cleanup();
                resolve(null);
            };
            reader.onload = () => {
                const dataUrl = String(reader.result);
                const base64 = dataUrl.substring(dataUrl.indexOf(",") + 1);
                cleanup();
                resolve({ name: file.name, base64 });
            };
            reader.readAsDataURL(file);
        });

        input.click();
    });
}

// Downloads text as a file.
export function downloadText(name, text) {
    const blob = new Blob([text], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
