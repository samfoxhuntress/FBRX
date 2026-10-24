import { zip } from '@fbrx/shared/node';
import { inlineText, safeHref, type Block, type Inline } from './markdown';
import { hasOwnTitle } from './render-html';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** Text width of a Letter page with one-inch margins, in twentieths of a point. */
const TEXT_WIDTH = 9360;

/** Escapes text for XML, leaving out the control characters XML 1.0 cannot carry. */
const x = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
}

interface Para {
  style?: string;
  num?: { id: number; level: number };
  /** Indent without a number or bullet (a later paragraph inside a list item). */
  indent?: number;
  align?: 'center' | 'right';
}

/** Lays out Markdown blocks as WordprocessingML, collecting the links and list numberings the document needs. */
class DocxBody {
  readonly links: string[] = [];
  /** Ordered lists, each numbered from its own start (bulleted lists all share numbering 1). */
  readonly ordered: Array<{ level: number; start: number }> = [];

  private runs(c: Inline[], st: RunStyle = {}): string {
    return c
      .map((i) => {
        switch (i.t) {
          case 'text':
            return this.run(i.v, st);
          case 'code':
            return this.run(i.v, { ...st, code: true });
          case 'bold':
            return this.runs(i.c, { ...st, bold: true });
          case 'italic':
            return this.runs(i.c, { ...st, italic: true });
          case 'link': {
            if (!safeHref(i.href)) return this.runs(i.c, st);
            this.links.push(i.href);
            return `<w:hyperlink r:id="rIdLink${this.links.length}" w:history="1">${this.runs(i.c, { ...st, link: true })}</w:hyperlink>`;
          }
        }
      })
      .join('');
  }

  private run(text: string, st: RunStyle): string {
    const style = st.code ? '<w:rStyle w:val="CodeChar"/>' : st.link ? '<w:rStyle w:val="Hyperlink"/>' : '';
    const props = `${style}${st.bold ? '<w:b/>' : ''}${st.italic ? '<w:i/>' : ''}`;
    const rPr = props ? `<w:rPr>${props}</w:rPr>` : '';
    return text
      .split('\n')
      .map((line, n) => `${n ? `<w:r>${rPr}<w:br/></w:r>` : ''}<w:r>${rPr}<w:t xml:space="preserve">${x(line)}</w:t></w:r>`)
      .join('');
  }

  private para(content: string, p: Para = {}): string {
    const pPr = [
      p.style ? `<w:pStyle w:val="${p.style}"/>` : '',
      p.num ? `<w:numPr><w:ilvl w:val="${p.num.level}"/><w:numId w:val="${p.num.id}"/></w:numPr>` : '',
      p.indent ? `<w:ind w:left="${p.indent}"/>` : '',
      p.align ? `<w:jc w:val="${p.align}"/>` : '',
    ].join('');
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
  }

  title(text: string): string {
    return this.para(this.run(text, {}), { style: 'Title' });
  }

  /** Blocks at a list depth (0 outside lists), in a quote or not. */
  blocks(list: Block[], depth = 0, quote = false): string {
    const plain = quote ? 'Quote' : undefined;
    return list
      .map((b) => {
        switch (b.t) {
          case 'heading':
            return this.para(this.runs(b.c), { style: `Heading${b.level}` });
          case 'para':
            return this.para(this.runs(b.c), { style: plain, indent: depth ? 720 * depth : undefined });
          case 'code':
            return b.v.split('\n').map((line) => this.para(this.run(line, {}), { style: 'Code' })).join('');
          case 'quote':
            return this.blocks(b.c, depth, true);
          case 'hr':
            return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D9D2C5"/></w:pBdr></w:pPr></w:p>';
          case 'table':
            return this.table(b);
          case 'list': {
            let id = 1;
            if (b.ordered) {
              this.ordered.push({ level: depth, start: b.start });
              id = this.ordered.length + 1;
            }
            return b.items
              .map((item) => {
                const [first, ...rest] = item;
                const lead = first?.t === 'para' ? this.para(this.runs(first.c), { style: 'ListParagraph', num: { id, level: Math.min(depth, 8) } }) : this.para('', { style: 'ListParagraph', num: { id, level: Math.min(depth, 8) } });
                const more = first?.t === 'para' ? rest : item;
                return lead + this.blocks(more, depth + 1, quote);
              })
              .join('');
          }
        }
      })
      .join('');
  }

  private table(b: Extract<Block, { t: 'table' }>): string {
    const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length));
    const width = Math.floor(TEXT_WIDTH / Math.max(1, cols));
    const row = (cells: Inline[][], head: boolean) =>
      `<w:tr>${head ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: cols }, (_, n) => {
        const align = b.align[n];
        const p = this.para(this.runs(cells[n] ?? [], { bold: head }), { align: align === 'center' || align === 'right' ? align : undefined });
        return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${p}</w:tc>`;
      }).join('')}</w:tr>`;
    return `<w:tbl><w:tblPr><w:tblStyle w:val="FbrxTable"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(cols)}</w:tblGrid>${row(b.head, true)}${b.rows.map((r) => row(r, false)).join('')}</w:tbl><w:p/>`;
  }
}

const heading = (level: number, size: number, before: number) =>
  `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="2B2620"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="1B1A17"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
${heading(1, 36, 360)}
${heading(2, 30, 320)}
${heading(3, 26, 280)}
${heading(4, 24, 240)}
${heading(5, 22, 240)}
${heading(6, 22, 240)}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="E2B04A"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:color w:val="554F45"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F3EE"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F4F0E8"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="A5630C"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="FbrxTable"><w:name w:val="FBRX Table"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="DDD6CA"/><w:left w:val="single" w:sz="4" w:space="0" w:color="DDD6CA"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="DDD6CA"/><w:right w:val="single" w:sz="4" w:space="0" w:color="DDD6CA"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="DDD6CA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="DDD6CA"/></w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F4F0E8"/></w:tcPr></w:tblStylePr></w:style>
</w:styles>`;

const BULLETS = ['•', '◦', '▪'];
const NUMBER_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman'];

function numbering(ordered: Array<{ level: number; start: number }>): string {
  const levels = (kind: 'bullet' | 'ordered') =>
    Array.from({ length: 9 }, (_, n) => {
      const fmt = kind === 'bullet' ? `<w:numFmt w:val="bullet"/><w:lvlText w:val="${BULLETS[n % 3]}"/>` : `<w:numFmt w:val="${NUMBER_FORMATS[n % 3]}"/><w:lvlText w:val="%${n + 1}."/>`;
      return `<w:lvl w:ilvl="${n}"><w:start w:val="1"/>${fmt}<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (n + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
    }).join('');
  const nums = ordered.map((o, n) => `<w:num w:numId="${n + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${Math.min(o.level, 8)}"><w:startOverride w:val="${o.start}"/></w:lvlOverride></w:num>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels('ordered')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${nums}</w:numbering>`;
}

/** A .docx document (Word-compatible) from Markdown blocks, with its title. */
export function renderDocx(title: string, list: Block[]): Buffer {
  const body = new DocxBody();
  const content = (hasOwnTitle(list) ? '' : body.title(title)) + body.blocks(list);
  const name = hasOwnTitle(list) ? inlineText((list[0] as Extract<Block, { t: 'heading' }>).c) : title;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${REL}"><w:body>${content}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const links = body.links.map((href, n) => `<Relationship Id="rIdLink${n + 1}" Type="${REL}/hyperlink" Target="${x(href)}" TargetMode="External"/>`).join('');
  return zip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    },
    {
      name: 'docProps/core.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(name)}</dc:title><dc:creator>FBRX</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`,
    },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: numbering(body.ordered) },
    {
      name: 'word/_rels/document.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="${REL}/numbering" Target="numbering.xml"/>${links}</Relationships>`,
    },
  ]);
}
