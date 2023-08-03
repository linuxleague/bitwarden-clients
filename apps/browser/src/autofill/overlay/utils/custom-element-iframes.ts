class AutofillOverlayCustomElementIframe extends HTMLElement {
  constructor(iframePath: string) {
    super();

    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL(iframePath);
    iframe.style.border = "none";
    iframe.style.background = "transparent";
    iframe.style.margin = "0";
    iframe.style.padding = "0";
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    // iframe.setAttribute("sandbox", "allow-scripts");

    const shadow = this.attachShadow({ mode: "closed" });
    shadow.appendChild(iframe);
  }
}

class AutofillOverlayIconIframe extends AutofillOverlayCustomElementIframe {
  constructor() {
    super("overlay/icon.html");
  }
}

class AutofillOverlayListIframe extends AutofillOverlayCustomElementIframe {
  constructor() {
    super("overlay/list.html");
  }
}

export { AutofillOverlayIconIframe, AutofillOverlayListIframe };