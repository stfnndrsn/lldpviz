/**
 * MikroTik LLDP neighbor output parser.
 *
 * Accepts the raw text from:
 *   /ip/neighbor/print detail where discovered-by~"lldp"
 *
 * Returns { sourceIdentity: string|null, neighbors: [ { ...fields } ] }
 */

const LLDPParser = (() => {
  'use strict';

  /**
   * Try to extract the source device identity from a MikroTik prompt line.
   * e.g. "[Stefan@GC-CCR2004] >" -> "GC-CCR2004"
   */
  function detectSourceIdentity(rawText) {
    const match = rawText.match(/\[.*?@(.+?)\]\s*>/);
    return match ? match[1] : null;
  }

  /**
   * Split raw output into individual neighbor record strings.
   * Records start with a line matching /^\s*\d+\s+/ (index number).
   */
  function splitRecords(rawText) {
    const lines = rawText.split('\n');
    const records = [];
    let current = null;

    for (const line of lines) {
      if (/^\s*\d+\s+/.test(line)) {
        if (current !== null) {
          records.push(current);
        }
        current = line.replace(/^\s*\d+\s+/, '');
      } else if (current !== null) {
        const trimmed = line.replace(/^\s+/, ' ');
        current += trimmed;
      }
    }
    if (current !== null) {
      records.push(current);
    }
    return records;
  }

  /**
   * Parse a single flattened record string into a key-value object.
   *
   * MikroTik format: key=value key2=value2 key3="value with spaces"
   * Values without quotes end at the next key= or end of string.
   */
  function parseRecord(recordStr) {
    const fields = {};
    const regex = /(\S+?)=("(?:[^"\\]|\\.)*"|[^\s]*(?:\s+[^\s=]+(?!=))*)/g;

    // More robust approach: find all key=value pairs
    // Keys are non-whitespace up to '=', values run until the next key= or end
    const tokens = tokenize(recordStr);
    for (const [key, value] of tokens) {
      fields[key] = value.replace(/^"|"$/g, '');
    }
    return fields;
  }

  /**
   * Tokenize a MikroTik key=value string.
   * Handles quoted values and unquoted values that may contain spaces
   * (values continue until we hit something that looks like a new key=).
   */
  function tokenize(str) {
    const results = [];
    let i = 0;
    const len = str.length;

    while (i < len) {
      // Skip whitespace
      while (i < len && /\s/.test(str[i])) i++;
      if (i >= len) break;

      // Find key (up to '=')
      const keyStart = i;
      while (i < len && str[i] !== '=' && !/\s/.test(str[i])) i++;
      if (i >= len || str[i] !== '=') {
        // Not a key=value pair, skip this token
        while (i < len && !/\s/.test(str[i])) i++;
        continue;
      }
      const key = str.substring(keyStart, i);
      i++; // skip '='

      // Parse value
      if (i < len && str[i] === '"') {
        // Quoted value
        i++; // skip opening quote
        const valStart = i;
        while (i < len && str[i] !== '"') {
          if (str[i] === '\\') i++; // skip escaped char
          i++;
        }
        const value = str.substring(valStart, i);
        if (i < len) i++; // skip closing quote
        results.push([key, value]);
      } else {
        // Unquoted value: collect until next key= pattern
        const valStart = i;
        let valEnd = i;
        let j = i;
        while (j < len) {
          // Look ahead: if we see whitespace followed by something= it's a new key
          if (/\s/.test(str[j])) {
            const rest = str.substring(j).match(/^\s+(\S+?)=/);
            if (rest) {
              valEnd = j;
              break;
            }
          }
          j++;
          valEnd = j;
        }
        const value = str.substring(valStart, valEnd).trim();
        results.push([key, value]);
        i = valEnd;
      }
    }
    return results;
  }

  /**
   * Extract the physical interface name from the interface field.
   * MikroTik may report "sfp-sfpplus2,bridge" or "sfp-sfpplus2- LAN,bridge"
   * -- we want the first part (physical interface), stripping the bridge membership.
   */
  function extractPhysicalInterface(ifaceStr) {
    if (!ifaceStr) return ifaceStr;
    // Split on comma, take first non-"bridge" entry
    const parts = ifaceStr.split(',');
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed !== 'bridge') return trimmed;
    }
    return parts[0].trim();
  }

  /**
   * Normalize a parsed record into a clean neighbor object.
   */
  function normalizeNeighbor(fields) {
    return {
      identity: fields['identity'] || '',
      macAddress: fields['mac-address'] || '',
      platform: fields['platform'] || '',
      board: fields['board'] || '',
      version: fields['version'] || '',
      systemDescription: fields['system-description'] || '',
      systemCaps: fields['system-caps'] || '',
      systemCapsEnabled: fields['system-caps-enabled'] || '',
      address: fields['address'] || fields['address4'] || '',
      address6: fields['address6'] || '',
      uptime: fields['uptime'] || '',
      softwareId: fields['software-id'] || '',
      localInterface: extractPhysicalInterface(fields['interface']),
      remoteInterface: fields['interface-name'] || '',
    };
  }

  /**
   * Main parse function.
   * @param {string} rawText - Raw MikroTik CLI output
   * @returns {{ sourceIdentity: string|null, neighbors: object[] }}
   */
  function parse(rawText) {
    const sourceIdentity = detectSourceIdentity(rawText);
    const recordStrings = splitRecords(rawText);
    const neighbors = recordStrings.map(r => normalizeNeighbor(parseRecord(r)));
    return { sourceIdentity, neighbors };
  }

  /**
   * Parse MikroTik tabular output with "Flags:" and "Columns:" header lines.
   * Handles comment lines (;;; ...) and multi-line continuation rows.
   * Returns array of objects with lowercase column keys + flags/comment fields.
   */
  function parseTabular(rawText) {
    const lines = rawText.split('\n');
    let flagDefs = {};
    let columns = [];
    let headerLine = -1;
    let colPositions = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*Flags:\s/i.test(line)) {
        const flagStr = line.replace(/^\s*Flags:\s*/i, '');
        for (const part of flagStr.split(/[;,]/)) {
          const m = part.trim().match(/^(\S+)\s*-\s*(.+)/);
          if (m) flagDefs[m[1]] = m[2].trim().toLowerCase();
        }
      }
      if (/^\s*Columns:\s/i.test(line)) {
        const colStr = line.replace(/^\s*Columns:\s*/i, '');
        columns = colStr.split(',').map(c => c.trim().toLowerCase().replace(/-/g, '_'));
      }
      if (/^\s*#\s/.test(line) && columns.length > 0) {
        headerLine = i;
        const headerText = line;
        colPositions = [];
        const upperCols = line.replace(/^\s*#\s*/, '').trimEnd();
        let searchFrom = line.indexOf(upperCols.split(/\s+/)[0]);
        const colNames = upperCols.split(/\s{2,}/);
        for (const cn of colNames) {
          const pos = line.indexOf(cn, searchFrom);
          colPositions.push(pos);
          searchFrom = pos + cn.length;
        }
        break;
      }
    }

    if (columns.length === 0 || headerLine < 0) return [];

    const results = [];
    let currentComment = '';

    for (let i = headerLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      if (/^\s*;;;/.test(line)) {
        currentComment = line.replace(/^\s*;;;\s*/, '').trim();
        continue;
      }

      const rowMatch = line.match(/^\s*(\d+)\s/);
      if (!rowMatch) continue;

      const flags = '';
      const flagChars = [];
      const numEnd = line.indexOf(rowMatch[1]) + rowMatch[1].length;
      const flagArea = line.substring(numEnd, colPositions[0] || numEnd).trim();
      for (const ch of flagArea) {
        if (flagDefs[ch]) flagChars.push(flagDefs[ch]);
      }

      const row = {};
      for (let c = 0; c < columns.length; c++) {
        const start = colPositions[c] || 0;
        const end = c + 1 < colPositions.length ? colPositions[c + 1] : line.length;
        row[columns[c]] = line.substring(start, end).trim();
      }

      row._flags = flagChars;
      row._running = flagChars.includes('running');
      row._disabled = flagChars.includes('disabled');
      row._slave = flagChars.includes('slave');
      row._dynamic = flagChars.includes('dynamic');
      if (currentComment) {
        row._comment = currentComment;
        currentComment = '';
      }

      results.push(row);
    }

    return results;
  }

  /**
   * Parse output of /interface/print without-paging (tabular format).
   */
  function parseInterfaces(rawText) {
    const rows = parseTabular(rawText);
    return rows.map(r => ({
      name: r.name || '',
      type: r.type || '',
      actualMtu: r.actual_mtu || r['actual-mtu'] || '',
      l2mtu: r.l2mtu || '',
      macAddress: r.mac_address || r['mac-address'] || '',
      comment: r._comment || '',
      running: r._running,
      disabled: r._disabled,
      slave: r._slave,
    })).filter(i => i.name);
  }

  /**
   * Parse output of /ip/address/print without-paging (tabular format).
   */
  function parseIPAddresses(rawText) {
    const rows = parseTabular(rawText);
    return rows.map(r => ({
      address: r.address || '',
      network: r.network || '',
      interface: r.interface || '',
      disabled: r._disabled,
      dynamic: r._dynamic,
      comment: r._comment || '',
    })).filter(i => i.address);
  }

  /**
   * Parse output of /interface/bridge/vlan/print without-paging.
   * Handles multi-line continuation where tagged/untagged ports span multiple lines.
   */
  function parseBridgeVlans(rawText) {
    const lines = rawText.split('\n');
    let columns = [];
    let headerLine = -1;
    let colPositions = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*Columns:\s/i.test(line)) {
        const colStr = line.replace(/^\s*Columns:\s*/i, '');
        columns = colStr.split(',').map(c => c.trim().toLowerCase().replace(/-/g, '_'));
      }
      if (/^\s*#\s/.test(line) && columns.length > 0) {
        headerLine = i;
        const upperCols = line.replace(/^\s*#\s*/, '').trimEnd();
        let searchFrom = line.indexOf(upperCols.split(/\s+/)[0]);
        const colNames = upperCols.split(/\s{2,}/);
        for (const cn of colNames) {
          const pos = line.indexOf(cn, searchFrom);
          colPositions.push(pos);
          searchFrom = pos + cn.length;
        }
        break;
      }
    }

    if (columns.length === 0 || headerLine < 0) return [];

    const results = [];
    let current = null;
    let currentComment = '';

    for (let i = headerLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      if (/^\s*;;;/.test(line)) {
        currentComment = line.replace(/^\s*;;;\s*/, '').trim();
        continue;
      }

      const rowMatch = line.match(/^\s*\d+\s/);
      if (rowMatch) {
        if (current) results.push(current);
        current = {};
        for (let c = 0; c < columns.length; c++) {
          const start = colPositions[c] || 0;
          const end = c + 1 < colPositions.length ? colPositions[c + 1] : line.length;
          const val = line.substring(start, end).trim();
          current[columns[c]] = val;
        }
        const flagArea = line.substring(0, colPositions[0] || 0);
        current._dynamic = flagArea.includes('D');
        if (currentComment) {
          current._comment = currentComment;
          currentComment = '';
        }
      } else if (current) {
        for (let c = 0; c < columns.length; c++) {
          const start = colPositions[c] || 0;
          const end = c + 1 < colPositions.length ? colPositions[c + 1] : line.length;
          const val = line.substring(start, end).trim();
          if (val) {
            current[columns[c]] = current[columns[c]]
              ? current[columns[c]] + ',' + val
              : val;
          }
        }
      }
    }
    if (current) results.push(current);

    return results.map(r => ({
      bridge: r.bridge || '',
      vlanIds: r.vlan_ids || '',
      tagged: r.current_tagged || '',
      untagged: r.current_untagged || '',
      comment: r._comment || '',
      dynamic: r._dynamic,
    })).filter(v => v.vlanIds);
  }

  /**
   * Split combined output of multiple MikroTik commands pasted together.
   * Detects command boundaries by looking for prompt lines like:
   *   [user@Device] > /some/command
   *   [user@Device] /some> command
   *
   * Returns { lldp, interfaces, ipAddresses, bridgeVlans } with raw text sections.
   */
  function splitCombinedOutput(rawText) {
    const promptPattern = /^\[.*?@.*?\]\s*[>/]/;
    const lines = rawText.split('\n');
    const sections = [];
    let currentCmd = '';
    let currentLines = [];

    for (const line of lines) {
      if (promptPattern.test(line)) {
        if (currentLines.length > 0) {
          sections.push({ cmd: currentCmd, text: currentLines.join('\n') });
        }
        currentCmd = line.replace(promptPattern, '').trim();
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }
    if (currentLines.length > 0) {
      sections.push({ cmd: currentCmd, text: currentLines.join('\n') });
    }

    const result = { lldp: '', interfaces: '', ipAddresses: '', bridgeVlans: '' };

    if (sections.length <= 1) {
      result.lldp = rawText;
      return result;
    }

    for (const section of sections) {
      const cmd = section.cmd.toLowerCase();
      if (cmd.includes('neighbor')) {
        result.lldp = section.text;
      } else if (cmd.includes('bridge/vlan') || cmd.includes('bridge vlan')) {
        result.bridgeVlans = section.text;
      } else if (cmd.includes('/ip/address') || cmd.includes('ip address') || cmd.includes('ip/address')) {
        result.ipAddresses = section.text;
      } else if (cmd.includes('/interface') || cmd.includes('interface print') || cmd.includes('interface/print')) {
        result.interfaces = section.text;
      } else if (!result.lldp) {
        result.lldp = section.text;
      }
    }

    return result;
  }

  return { parse, detectSourceIdentity, parseInterfaces, parseIPAddresses, parseBridgeVlans, splitCombinedOutput };
})();
