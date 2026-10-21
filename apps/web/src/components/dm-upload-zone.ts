import { LitElement, css, html } from "lit";
import { ServicesController } from "../state/services-controller";
import { UPLOAD_EXTENSIONS, type UploadReason, type UploadResult } from "../state/uploads";
import { baseStyles } from "../styles/base";
import "./dm-icon";

const REASONS: Record<UploadReason, string> = {
  too_large: "Too large (50 MB limit).",
  unsupported: "File type not supported.",
  quota: "Storage limit reached.",
  network: "Connection lost.",
  server: "Something went wrong. Try again.",
  cancelled: "Cancelled.",
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * DocMind's own drop zone: many files, a drop target, a per-file queue. The size and type checks are UX only; the server
 * checks again. File names are shown as text only and never logged or put in a toast. Its uploads stop when it leaves the page.
 */
export class DmUploadZone extends LitElement {
  static properties = { variant: { type: String }, dragging: { state: true } };
  static styles = [
    baseStyles,
    css`
      :host { display: block; }
      [data-zone] { display: grid; justify-items: center; gap: 6px; padding: 18px 16px; border: 1px dashed var(--dm-divider); border-radius: var(--dm-radius-lg); text-align: center; }
      :host([variant="empty"]) [data-zone] { padding: 48px 16px; }
      [data-zone][data-over] { border-color: var(--dm-accent); background: color-mix(in srgb, var(--dm-accent) 8%, transparent); }
      p { margin: 0; }
      ul { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; }
      li { display: flex; align-items: center; gap: 10px; font-size: 13px; }
      .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      progress { width: 120px; }
      .err { color: var(--dm-err); }
    `,
  ];
  declare variant: "compact" | "empty";
  declare dragging: number;
  private readonly ctx = new ServicesController(this, (s) => [s.uploads]);
  constructor() {
    super();
    this.variant = "compact";
    this.dragging = 0;
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.ctx.services?.uploads.cancelAll();
  }
  private async send(files: File[]): Promise<void> {
    const services = this.ctx.services;
    if (!services || files.length === 0) return;
    const results = await services.uploads.upload(files);
    this.announce(results);
    this.dispatchEvent(
      new CustomEvent("dm-uploaded", { detail: { results }, bubbles: true, composed: true }),
    );
  }
  /** Fixed sentences with counts only: a file name never goes to the live region. */
  private announce(results: UploadResult[]): void {
    const toasts = this.ctx.services?.toasts;
    const failed = results.filter((r) => r.reason && r.reason !== "cancelled").length;
    const done = results.filter((r) => r.document).length;
    if (failed > 0)
      toasts?.push({ kind: "err", text: `${plural(failed, "upload", "uploads")} failed` });
    else if (done > 0)
      toasts?.push({ kind: "ok", text: `${plural(done, "upload", "uploads")} finished` });
  }
  private onDrag = (e: Event) => {
    e.preventDefault();
    const dt = (e as DragEvent).dataTransfer;
    if (e.type === "dragover" && dt) dt.dropEffect = "copy";
    this.dragging = e.type === "dragleave" ? 0 : (dt?.items?.length ?? 0);
  };
  private onDrop = (e: Event) => {
    e.preventDefault();
    this.dragging = 0;
    const dt = (e as DragEvent).dataTransfer;
    const items = [...(dt?.items ?? [])] as DataTransferItem[];
    const folder = items.some((i) => i.kind === "file" && i.webkitGetAsEntry?.()?.isDirectory);
    if (folder || !dt) return; // a dropped folder is ignored
    void this.send([...dt.files]);
  };
  private onPick = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    try {
      input.value = "";
    } catch {
      /* a file input may refuse; the files are already read */
    }
    void this.send(files);
  };
  render() {
    const uploads = this.ctx.services?.uploads;
    const items = uploads?.get().uploads ?? [];
    return html`
      <div data-zone ?data-over=${this.dragging > 0} @dragenter=${this.onDrag} @dragover=${this.onDrag} @dragleave=${this.onDrag} @drop=${this.onDrop}>
        <dm-icon name="upload-simple"></dm-icon>
        <p>${this.dragging > 0 ? `Release to upload ${plural(this.dragging, "file", "files")}` : html`Drop files here or <button class="btn ghost" data-browse @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>("input[type=file]")?.click()}>browse</button>`}</p>
        <p class="muted">PDF, DOCX, DOC, TXT, Markdown, Org, PNG, JPG, WEBP - up to 50 MB each</p>
        <input type="file" multiple hidden accept=${UPLOAD_EXTENSIONS.map((x) => `.${x}`).join(",")} @change=${this.onPick} />
      </div>
      ${
        items.length === 0
          ? null
          : html`<ul>${items.map(
              (u) => html`
        <li data-upload>
          <span class="name">${u.name}</span>
          ${
            u.state === "failed"
              ? html`<span class="err">${REASONS[u.reason ?? "server"]}</span><button class="btn ghost" data-dismiss aria-label=${`Dismiss ${u.name}`} @click=${() => uploads?.dismissUpload(u.key)}>Dismiss</button>`
              : html`${
                  u.state === "uploading"
                    ? html`<span>Uploading ${u.percent}%</span><progress max="100" .value=${u.percent} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${u.percent} aria-label=${`Upload progress for ${u.name}`}></progress>`
                    : html`<span>Waiting</span>`
                }<button class="btn ghost" data-cancel aria-label=${`Cancel ${u.name}`} @click=${() => uploads?.cancel(u.key)}>Cancel</button>`
          }
        </li>`,
            )}</ul>`
      }`;
  }
}
customElements.define("dm-upload-zone", DmUploadZone);
