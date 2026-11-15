// lib/reportWord.js
// Generates standard Microsoft Word (.docx / Office Open XML) documents for monthly reports.
// Uses native ZIP packaging (STORE method 0) without third-party binary dependencies.

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

function createZip(files) {
  const fileEntries = [];
  let offset = 0;
  const parts = [];

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const dataBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const crc = crc32(dataBuf);
    const size = dataBuf.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4);          // Version needed
    localHeader.writeUInt16LE(0, 6);           // Flags
    localHeader.writeUInt16LE(0, 8);           // Compression (0 = stored)
    localHeader.writeUInt16LE(0, 10);          // Mod time
    localHeader.writeUInt16LE(0, 12);          // Mod date
    localHeader.writeUInt32LE(crc, 14);        // CRC32
    localHeader.writeUInt32LE(size, 18);       // Compressed size
    localHeader.writeUInt32LE(size, 22);       // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // File name length
    localHeader.writeUInt16LE(0, 28);          // Extra field length

    fileEntries.push({ nameBuf, crc, size, offset });
    parts.push(localHeader, nameBuf, dataBuf);
    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralDirectoryOffset = offset;
  let centralDirectorySize = 0;

  for (const entry of fileEntries) {
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    cdHeader.writeUInt16LE(20, 4);          // Version made by
    cdHeader.writeUInt16LE(20, 6);          // Version needed
    cdHeader.writeUInt16LE(0, 8);           // Flags
    cdHeader.writeUInt16LE(0, 10);          // Compression (0 = stored)
    cdHeader.writeUInt16LE(0, 12);          // Mod time
    cdHeader.writeUInt16LE(0, 14);          // Mod date
    cdHeader.writeUInt32LE(entry.crc, 16);  // CRC32
    cdHeader.writeUInt32LE(entry.size, 20); // Compressed size
    cdHeader.writeUInt32LE(entry.size, 24); // Uncompressed size
    cdHeader.writeUInt16LE(entry.nameBuf.length, 28); // Name length
    cdHeader.writeUInt16LE(0, 30);          // Extra field length
    cdHeader.writeUInt16LE(0, 32);          // Comment length
    cdHeader.writeUInt16LE(0, 34);          // Disk number start
    cdHeader.writeUInt16LE(0, 36);          // Internal attributes
    cdHeader.writeUInt32LE(0, 38);          // External attributes
    cdHeader.writeUInt32LE(entry.offset, 42); // Relative offset of local header

    parts.push(cdHeader, entry.nameBuf);
    centralDirectorySize += cdHeader.length + entry.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);          // Disk number
  eocd.writeUInt16LE(0, 6);          // Disk with CD
  eocd.writeUInt16LE(fileEntries.length, 8);  // Entries on this disk
  eocd.writeUInt16LE(fileEntries.length, 10); // Total entries
  eocd.writeUInt32LE(centralDirectorySize, 12); // Size of central directory
  eocd.writeUInt32LE(centralDirectoryOffset, 16); // Offset of central directory
  eocd.writeUInt16LE(0, 20);         // Comment length

  parts.push(eocd);
  return Buffer.concat(parts);
}

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildMonthlyReportDocx(reportData) {
  const { team, periodLabel, generatedAt, generatedBy, kpis, memberBreakdown, unassignedTasks } = reportData;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:color w:val="0F172A"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="120" w:line="260" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
</w:styles>`;

  let doc = '';

  // Banner Header
  doc += `
    <w:p>
      <w:pPr><w:spacing w:after="40"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="48"/><w:color w:val="4F46E5"/></w:rPr><w:t>ProMa.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:spacing w:after="80"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="0F172A"/></w:rPr><w:t>Monthly Performance &amp; Activity Report</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr>
        <w:pBdr><w:bottom w:val="single" w:sz="16" w:space="8" w:color="4F46E5"/></w:pBdr>
        <w:spacing w:after="240"/>
      </w:pPr>
      <w:r><w:rPr><w:b/><w:color w:val="334155"/></w:rPr><w:t>Team Workspace: ${escapeXml(team?.name || 'Workspace')}</w:t></w:r>
      <w:r><w:rPr><w:color w:val="64748B"/></w:rPr><w:t>   |   Period: ${escapeXml(periodLabel)}   |   Generated: ${escapeXml(new Date(generatedAt || Date.now()).toLocaleDateString())}   |   Prepared By: ${escapeXml(generatedBy || "Lead")}</w:t></w:r>
    </w:p>
  `;

  // Section 1: Executive Summary & KPIs
  doc += `
    <w:p>
      <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="0F172A"/></w:rPr><w:t>Executive Summary &amp; Key Performance Indicators</w:t></w:r>
    </w:p>
  `;

  // KPI Table (5 equal columns: Total width 9000 dxa ~ 6.25 in)
  const safeKpis = kpis || { total: 0, complete: 0, inProgress: 0, overdue: 0, completionPct: 0 };
  doc += `
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="9000" w:type="dxa"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
          <w:bottom w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
          <w:left w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
          <w:right w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
          <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
          <w:insideV w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
        </w:tblBorders>
      </w:tblPr>
      <w:tblGrid>
        <w:gridCol w:w="1800"/>
        <w:gridCol w:w="1800"/>
        <w:gridCol w:w="1800"/>
        <w:gridCol w:w="1800"/>
        <w:gridCol w:w="1800"/>
      </w:tblGrid>
      <w:tr>
        <w:tc>
          <w:tcPr><w:tcW w:w="1800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/><w:vAlign w:val="center"/></w:tcPr>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="0F172A"/></w:rPr><w:t>${safeKpis.total}</w:t></w:r></w:p>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="16"/><w:color w:val="64748B"/></w:rPr><w:t>TOTAL ACTIVITIES</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:tcW w:w="1800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F0FDF4"/><w:vAlign w:val="center"/></w:tcPr>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="16A34A"/></w:rPr><w:t>${safeKpis.complete}</w:t></w:r></w:p>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="16"/><w:color w:val="16A34A"/></w:rPr><w:t>COMPLETED</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:tcW w:w="1800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="FEFCE8"/><w:vAlign w:val="center"/></w:tcPr>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="CA8A04"/></w:rPr><w:t>${safeKpis.inProgress}</w:t></w:r></w:p>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="16"/><w:color w:val="CA8A04"/></w:rPr><w:t>IN PROGRESS</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:tcW w:w="1800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="FEF2F2"/><w:vAlign w:val="center"/></w:tcPr>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="DC2626"/></w:rPr><w:t>${safeKpis.overdue}</w:t></w:r></w:p>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="16"/><w:color w:val="DC2626"/></w:rPr><w:t>DUE / OVERDUE</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:tcW w:w="1800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="EEF2FF"/><w:vAlign w:val="center"/></w:tcPr>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="4F46E5"/></w:rPr><w:t>${safeKpis.completionPct}%</w:t></w:r></w:p>
          <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="16"/><w:color w:val="4F46E5"/></w:rPr><w:t>DELIVERY RATE</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
  `;

  // Health Assessment
  const healthDesc = safeKpis.completionPct >= 75
    ? `High Performance / On Track (${safeKpis.complete} of ${safeKpis.total} activities delivered - ${safeKpis.completionPct}%)`
    : safeKpis.completionPct >= 50
    ? `Moderate Velocity / Progressing (${safeKpis.complete} of ${safeKpis.total} activities delivered - ${safeKpis.completionPct}%)`
    : `Action Needed / Behind Schedule (${safeKpis.complete} of ${safeKpis.total} activities delivered - ${safeKpis.completionPct}%)`;

  doc += `
    <w:p>
      <w:pPr>
        <w:spacing w:before="160" w:after="260"/>
        <w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="4F46E5"/></w:pBdr>
        <w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/>
      </w:pPr>
      <w:r><w:rPr><w:b/><w:color w:val="0F172A"/></w:rPr><w:t>Team Health Rating: </w:t></w:r>
      <w:r><w:rPr><w:color w:val="334155"/></w:rPr><w:t>${escapeXml(healthDesc)}</w:t></w:r>
    </w:p>
  `;

  // Section 2: Member Breakdown
  doc += `
    <w:p>
      <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="0F172A"/></w:rPr><w:t>Member-by-Member Activity Log &amp; Contribution</w:t></w:r>
    </w:p>
  `;

  if (!memberBreakdown || memberBreakdown.length === 0) {
    doc += `
      <w:p><w:r><w:rPr><w:color w:val="94A3B8"/><w:i/></w:rPr><w:t>No members found in this team workspace.</w:t></w:r></w:p>
    `;
  } else {
    memberBreakdown.forEach((mb) => {
      const m = mb.member || {};
      doc += `
        <w:p>
          <w:pPr><w:spacing w:before="200" w:after="40"/></w:pPr>
          <w:r><w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="0F172A"/></w:rPr><w:t>${escapeXml(m.full_name || 'Member')}</w:t></w:r>
          <w:r><w:rPr><w:color w:val="64748B"/></w:rPr><w:t>  (${escapeXml(m.role || 'Member')})  ·  ${escapeXml(m.designation ? m.designation + ' · ' : '')}${escapeXml(m.email || '')}</w:t></w:r>
        </w:p>
        <w:p>
          <w:pPr><w:spacing w:before="0" w:after="100"/></w:pPr>
          <w:r><w:rPr><w:b/><w:color w:val="16A34A"/></w:rPr><w:t>${mb.complete || 0} Done</w:t></w:r>
          <w:r><w:t>   ·   </w:t></w:r>
          <w:r><w:rPr><w:b/><w:color w:val="CA8A04"/></w:rPr><w:t>${mb.inProgress || 0} Active</w:t></w:r>
          <w:r><w:t>   ·   </w:t></w:r>
          <w:r><w:rPr><w:b/><w:color w:val="DC2626"/></w:rPr><w:t>${mb.overdue || 0} Overdue</w:t></w:r>
          <w:r><w:t>   ·   </w:t></w:r>
          <w:r><w:rPr><w:b/><w:color w:val="4F46E5"/></w:rPr><w:t>${mb.completionPct || 0}% Delivery Rate</w:t></w:r>
        </w:p>
      `;

      // Table of tasks
      doc += `
        <w:tbl>
          <w:tblPr>
            <w:tblW w:w="9000" w:type="dxa"/>
            <w:tblBorders>
              <w:top w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
              <w:bottom w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
              <w:left w:val="none"/>
              <w:right w:val="none"/>
              <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
              <w:insideV w:val="none"/>
            </w:tblBorders>
          </w:tblPr>
          <w:tblGrid>
            <w:gridCol w:w="3800"/>
            <w:gridCol w:w="1400"/>
            <w:gridCol w:w="2200"/>
            <w:gridCol w:w="1600"/>
          </w:tblGrid>
          <w:tr>
            <w:tc><w:tcPr><w:tcW w:w="3800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/></w:tcPr>
              <w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="18"/><w:color w:val="475569"/></w:rPr><w:t>ACTIVITY / TASK</w:t></w:r></w:p>
            </w:tc>
            <w:tc><w:tcPr><w:tcW w:w="1400" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/></w:tcPr>
              <w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="18"/><w:color w:val="475569"/></w:rPr><w:t>STATUS</w:t></w:r></w:p>
            </w:tc>
            <w:tc><w:tcPr><w:tcW w:w="2200" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/></w:tcPr>
              <w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="18"/><w:color w:val="475569"/></w:rPr><w:t>TIMELINE</w:t></w:r></w:p>
            </w:tc>
            <w:tc><w:tcPr><w:tcW w:w="1600" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/></w:tcPr>
              <w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="18"/><w:color w:val="475569"/></w:rPr><w:t>NOTES</w:t></w:r></w:p>
            </w:tc>
          </w:tr>
      `;

      if (!mb.tasks || mb.tasks.length === 0) {
        doc += `
          <w:tr>
            <w:tc><w:tcPr><w:tcW w:w="9000" w:type="dxa"/><w:gridSpan w:val="4"/></w:tcPr>
              <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:color w:val="94A3B8"/><w:i/></w:rPr><w:t>No activities assigned for this period.</w:t></w:r></w:p>
            </w:tc>
          </w:tr>
        `;
      } else {
        mb.tasks.forEach((t) => {
          const statusColor = t.effectiveStatus === 'complete' ? '16A34A' : t.effectiveStatus === 'overdue' ? 'DC2626' : (t.effectiveStatus === 'in_progress' ? 'CA8A04' : '475569');
          const statusLabel = t.effectiveStatus === 'complete' ? 'Completed' : t.effectiveStatus === 'overdue' ? 'Overdue' : (t.effectiveStatus === 'in_progress' ? 'In Progress' : 'To Do');
          const timeline = `${t.startDate || '—'} → ${t.deadline || '—'}`;
          doc += `
            <w:tr>
              <w:tc>
                <w:tcPr><w:tcW w:w="3800" w:type="dxa"/></w:tcPr>
                <w:p><w:pPr><w:spacing w:after="20"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="0F172A"/></w:rPr><w:t>${escapeXml(t.title)}</w:t></w:r></w:p>
                ${t.description ? `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="64748B"/></w:rPr><w:t>${escapeXml(t.description)}</w:t></w:r></w:p>` : ''}
              </w:tc>
              <w:tc>
                <w:tcPr><w:tcW w:w="1400" w:type="dxa"/></w:tcPr>
                <w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="${statusColor}"/></w:rPr><w:t>${escapeXml(statusLabel)}</w:t></w:r></w:p>
              </w:tc>
              <w:tc>
                <w:tcPr><w:tcW w:w="2200" w:type="dxa"/></w:tcPr>
                <w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="475569"/></w:rPr><w:t>${escapeXml(timeline)}</w:t></w:r></w:p>
              </w:tc>
              <w:tc>
                <w:tcPr><w:tcW w:w="1600" w:type="dxa"/></w:tcPr>
                <w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="64748B"/></w:rPr><w:t>${escapeXml(t.effectiveStatus === 'complete' ? 'Delivered' : t.effectiveStatus === 'overdue' ? 'Urgent' : 'Active')}</w:t></w:r></w:p>
              </w:tc>
            </w:tr>
          `;
        });
      }
      doc += `</w:tbl>`;
    });
  }

  // Section 3: Unassigned tasks
  if (unassignedTasks && unassignedTasks.length > 0) {
    doc += `
      <w:p>
        <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
        <w:r><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="0F172A"/></w:rPr><w:t>Unassigned Team Activities (${unassignedTasks.length})</w:t></w:r>
      </w:p>
      <w:tbl>
        <w:tblPr>
          <w:tblW w:w="9000" w:type="dxa"/>
          <w:tblBorders>
            <w:top w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
            <w:bottom w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
            <w:left w:val="none"/>
            <w:right w:val="none"/>
            <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
            <w:insideV w:val="none"/>
          </w:tblBorders>
        </w:tblPr>
        <w:tblGrid>
          <w:gridCol w:w="4800"/>
          <w:gridCol w:w="2000"/>
          <w:gridCol w:w="2200"/>
        </w:tblGrid>
        <w:tr>
          <w:tc><w:tcPr><w:tcW w:w="4800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/></w:tcPr>
            <w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="18"/><w:color w:val="475569"/></w:rPr><w:t>ACTIVITY NAME</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/></w:tcPr>
            <w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="18"/><w:color w:val="475569"/></w:rPr><w:t>STATUS</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr><w:tcW w:w="2200" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/></w:tcPr>
            <w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="18"/><w:color w:val="475569"/></w:rPr><w:t>DEADLINE</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
    `;
    unassignedTasks.forEach((t) => {
      doc += `
        <w:tr>
          <w:tc><w:tcPr><w:tcW w:w="4800" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="0F172A"/></w:rPr><w:t>${escapeXml(t.title)}</w:t></w:r></w:p></w:tc>
          <w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>${escapeXml(t.effectiveStatus)}</w:t></w:r></w:p></w:tc>
          <w:tc><w:tcPr><w:tcW w:w="2200" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>${escapeXml(t.deadline || '—')}</w:t></w:r></w:p></w:tc>
        </w:tr>
      `;
    });
    doc += `</w:tbl>`;
  }

  // Signoff Box
  doc += `
    <w:p><w:pPr><w:spacing w:before="360" w:after="100"/></w:pPr></w:p>
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="9000" w:type="dxa"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
          <w:bottom w:val="none"/>
          <w:left w:val="none"/>
          <w:right w:val="none"/>
          <w:insideH w:val="none"/>
          <w:insideV w:val="none"/>
        </w:tblBorders>
      </w:tblPr>
      <w:tblGrid>
        <w:gridCol w:w="4500"/>
        <w:gridCol w:w="4500"/>
      </w:tblGrid>
      <w:tr>
        <w:tc>
          <w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr>
          <w:p><w:pPr><w:spacing w:before="120" w:after="40"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Prepared by: ${escapeXml(generatedBy || "Project Lead")}</w:t></w:r></w:p>
          <w:p><w:pPr><w:spacing w:before="180" w:after="40"/></w:pPr><w:r><w:rPr><w:color w:val="94A3B8"/></w:rPr><w:t>_____________________________________________</w:t></w:r></w:p>
          <w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="64748B"/></w:rPr><w:t>Signature &amp; Date</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr>
          <w:p><w:pPr><w:spacing w:before="120" w:after="40"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Approved by: Management Review</w:t></w:r></w:p>
          <w:p><w:pPr><w:spacing w:before="180" w:after="40"/></w:pPr><w:r><w:rPr><w:color w:val="94A3B8"/></w:rPr><w:t>_____________________________________________</w:t></w:r></w:p>
          <w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="64748B"/></w:rPr><w:t>Executive / Manager Sign-off</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
  `;

  // Standard Page setup (A4, 1-inch margins)
  doc += `
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  `;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${doc}
  </w:body>
</w:document>`;

  return createZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: styles }
  ]);
}

module.exports = { buildMonthlyReportDocx };
