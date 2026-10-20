import { crc32 } from "node:zlib";

/** Test-only: a minimal docx (what mammoth needs) as a stored zip; one paragraph per entry of `paragraphs`. */
export function docxBytes(paragraphs: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
  const head = '<?xml version="1.0" encoding="UTF-8"?>';
  const files: [string, string][] = [
    [
      "[Content_Types].xml",
      `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `${head}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ],
    [
      "word/document.xml",
      `${head}<w:document xmlns:w="${W}"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${esc(p)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
    ],
  ];
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const n = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, n]));
    parts.push(local, n, data);
    offset += 30 + n.length + data.length;
  }
  const cdBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBytes, end]);
}
