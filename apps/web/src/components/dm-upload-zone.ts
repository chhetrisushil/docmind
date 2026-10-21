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
 * checks again. File names are shown as text only and never logged or put in a toast. Uploads belong to the store, not to this element: they go on when it leaves the page and stop on sign-out or Cancel.
 */
export class DmUploadZone extends LitElement {
  static properties = {
    variant: { type: String },
    hideQueue: { type: Boolean, attribute: "hide-queue" },
    dragging: { state: true },
  };
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
  /** Set on all but one zone of a page so a queue is listed (and read out) once. */
  declare hideQueue: boolean;
  declare dragging: number;
  private depth = 0;
  private readonly ctx = new ServicesController(this, (s) => [s.uploads]);
  constructor() {
    super();
    this.variant = "compact";
    this.dragging = 0;
    this.hideQueue = false;
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
    // enter and leave fire for every child the pointer crosses: only the last leave ends the drag
    if (e.type === "dragenter") this.depth++;
    else if (e.type === "dragleave") this.depth = Math.max(0, this.depth - 1);
    if (e.type === "dragleave") this.dragging = this.depth === 0 ? 0 : this.dragging;
    else this.dragging = dt?.items?.length ?? this.dragging;
  };
  private onDrop = (e: Event) => {
    e.preventDefault();
    this.depth = 0;
    this.dragging = 0;
    const dt = (e as DragEvent).dataTransfer;
    if (!dt) return;
    const files = [...dt.files];
    const items = [...(dt.items ?? [])] as DataTransferItem[];
    const isDir = (i: DataTransferItem | undefined) =>
      i?.kind === "file" && i.webkitGetAsEntry?.()?.isDirectory === true;
    // Items and files line up one to one; a folder is skipped, the rest go on.
    const keep =
      items.length === files.length
        ? files.filter((_, at) => !isDir(items[at]))
        : items.some(isDir)
          ? []
          : files;
    if (keep.length < files.length || (files.length === 0 && items.some(isDir)))
      this.ctx.services?.toasts.push({
        kind: "err",
        text: "Folders are not supported and were skipped",
      });
    void this.send(keep);
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
    const count = (state: string) => items.filter((u) => u.state === state).length;
    const summary = [
      ["waiting", "queued"],
      ["uploading", "uploading"],
      ["failed", "failed"],
    ]
      .flatMap(([word, state]) =>
        count(state as string) > 0
          ? [`${count(state as string)} ${word === "waiting" ? "waiting" : word}`]
          : [],
      )
      .join(", ");
    return html`
      ${this.hideQueue ? null : html`<p class="sr-only" data-status role="status" aria-live="polite" aria-atomic="true">${summary}</p>`}
      <div data-zone ?data-over=${this.dragging > 0} @dragenter=${this.onDrag} @dragover=${this.onDrag} @dragleave=${this.onDrag} @drop=${this.onDrop}>
        <dm-icon name="upload-simple"></dm-icon>
        <p>${this.dragging > 0 ? `Release to upload ${plural(this.dragging, "file", "files")}` : html`Drop files here or <button class="btn ghost" data-browse @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>("input[type=file]")?.click()}>browse</button>`}</p>
        <p class="muted">PDF, DOCX, DOC, TXT, Markdown, Org, PNG, JPG, WEBP - up to 50 MB each</p>
        <input type="file" multiple hidden accept=${UPLOAD_EXTENSIONS.map((x) => `.${x}`).join(",")} @change=${this.onPick} />
      </div>
      ${
        items.length === 0 || this.hideQueue
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
