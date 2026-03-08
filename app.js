/**
 * LLDP Network Topology Visualizer
 * Site management, topology state (localStorage), vis.js graph rendering.
 */

const App = (() => {
  'use strict';

  const STORAGE_KEY = 'lldp-grpaviz-sites';
  const SITE_ID_KEY = 'lldp-grpaviz-current-site';
  let currentSiteId = null;
  let network = null;
  let nodesDataSet = null;
  let edgesDataSet = null;
  let selectedNodeId = null;
  let traverseState = null;
  let viewMode = 'network';
  let rootNodeId = null;
  let sharedSiteId = null;
  let sharedRevision = null;
  let sharedRevisions = [];

  // ── localStorage helpers ──────────────────────────────────────────

  function loadSites() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveSites(sites) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sites));
  }

  function getSite(id) {
    return loadSites()[id] || null;
  }

  function createSite(name) {
    const sites = loadSites();
    const id = 'site_' + Date.now();
    sites[id] = { id, name, devices: {}, connections: [] };
    saveSites(sites);
    return id;
  }

  function deleteSite(id) {
    const sites = loadSites();
    delete sites[id];
    saveSites(sites);
  }

  function updateSite(site) {
    const sites = loadSites();
    sites[site.id] = site;
    saveSites(sites);
  }

  // ── Topology logic ────────────────────────────────────────────────

  function connectionKey(a, b) {
    return [a, b].sort().join('||');
  }

  /**
   * Merge parsed LLDP data into a site's topology.
   * @param {string} siteId
   * @param {string} sourceIdentity - hostname of the device that produced the output
   * @param {string} sourceBoard - board model (optional)
   * @param {string} sourceMac - MAC address (optional)
   * @param {object[]} neighbors - parsed neighbor objects from LLDPParser
   */
  function mergeTopology(siteId, sourceIdentity, sourceBoard, sourceMac, neighbors) {
    const site = getSite(siteId);
    if (!site) return;

    const now = new Date().toISOString();

    // Upsert source device
    if (!site.devices[sourceIdentity]) {
      site.devices[sourceIdentity] = {
        identity: sourceIdentity,
        macAddress: sourceMac || '',
        platform: 'MikroTik',
        board: sourceBoard || '',
        version: '',
        systemDescription: '',
        systemCaps: '',
        systemCapsEnabled: '',
        address: '',
        address6: '',
        scanned: true,
        lastSeen: now,
      };
    } else {
      const d = site.devices[sourceIdentity];
      if (sourceBoard) d.board = sourceBoard;
      if (sourceMac) d.macAddress = sourceMac;
      d.scanned = true;
      d.lastSeen = now;
    }

    // Build a lookup for existing connections by key
    const connMap = {};
    for (const c of site.connections) {
      connMap[connectionKey(c.fromIdentity, c.toIdentity)] = c;
    }

    for (const n of neighbors) {
      if (!n.identity) continue;

      // Upsert neighbor device
      if (!site.devices[n.identity]) {
        site.devices[n.identity] = {
          identity: n.identity,
          macAddress: n.macAddress,
          platform: n.platform,
          board: n.board,
          version: n.version,
          systemDescription: n.systemDescription,
          systemCaps: n.systemCaps,
          systemCapsEnabled: n.systemCapsEnabled,
          address: n.address,
          address6: n.address6,
          lastSeen: now,
        };
      } else {
        const d = site.devices[n.identity];
        if (n.board) d.board = n.board;
        if (n.macAddress) d.macAddress = n.macAddress;
        if (n.version) d.version = n.version;
        if (n.systemDescription) d.systemDescription = n.systemDescription;
        if (n.systemCaps) d.systemCaps = n.systemCaps;
        if (n.address) d.address = n.address;
        if (n.address6) d.address6 = n.address6;
        d.lastSeen = now;
      }

      // Upsert connection (deduplicate bidirectional)
      const key = connectionKey(sourceIdentity, n.identity);
      if (connMap[key]) {
        const c = connMap[key];
        // Update interface info from whichever side is reporting
        if (c.fromIdentity === sourceIdentity) {
          c.fromInterface = n.localInterface || c.fromInterface;
          c.toInterface = n.remoteInterface || c.toInterface;
        } else {
          c.toInterface = n.localInterface || c.toInterface;
          c.fromInterface = n.remoteInterface || c.fromInterface;
        }
        c.lastSeen = now;
      } else {
        const conn = {
          fromIdentity: sourceIdentity,
          toIdentity: n.identity,
          fromInterface: n.localInterface || '',
          toInterface: n.remoteInterface || '',
          lastSeen: now,
        };
        site.connections.push(conn);
        connMap[key] = conn;
      }
    }

    updateSite(site);
  }

  // ── vis.js graph rendering ────────────────────────────────────────

  function deviceShape(caps) {
    if (!caps) return { shape: 'dot', color: '#6c7a89' };
    const c = caps.toLowerCase();
    if (c.includes('router') && !c.includes('bridge')) {
      return { shape: 'diamond', color: '#e74c3c' };
    }
    if (c.includes('router') && c.includes('bridge')) {
      return { shape: 'hexagon', color: '#e67e22' };
    }
    if (c.includes('bridge')) {
      return { shape: 'box', color: '#3498db' };
    }
    if (c.includes('wlan-ap')) {
      return { shape: 'triangle', color: '#2ecc71' };
    }
    return { shape: 'dot', color: '#6c7a89' };
  }

  /**
   * Build adjacency list from site connections.
   */
  function buildAdjacency(site) {
    const adj = {};
    for (const id of Object.keys(site.devices)) {
      adj[id] = [];
    }
    for (const conn of site.connections) {
      if (adj[conn.fromIdentity]) adj[conn.fromIdentity].push(conn.toIdentity);
      if (adj[conn.toIdentity]) adj[conn.toIdentity].push(conn.fromIdentity);
    }
    return adj;
  }

  /**
   * BFS from rootId, returns Map<nodeId, level>.
   * Unreachable nodes get level = maxLevel + 1.
   */
  function bfsLevels(site, rootId) {
    const adj = buildAdjacency(site);
    const levels = new Map();
    const queue = [rootId];
    levels.set(rootId, 0);

    while (queue.length > 0) {
      const current = queue.shift();
      const currentLevel = levels.get(current);
      for (const neighbor of (adj[current] || [])) {
        if (!levels.has(neighbor)) {
          levels.set(neighbor, currentLevel + 1);
          queue.push(neighbor);
        }
      }
    }

    let maxLevel = 0;
    for (const l of levels.values()) {
      if (l > maxLevel) maxLevel = l;
    }
    for (const id of Object.keys(site.devices)) {
      if (!levels.has(id)) {
        levels.set(id, maxLevel + 1);
      }
    }

    return levels;
  }

  /**
   * Pick the best automatic root: the node with the most connections.
   */
  function pickDefaultRoot(site) {
    const adj = buildAdjacency(site);
    let best = null;
    let bestCount = -1;
    for (const [id, neighbors] of Object.entries(adj)) {
      if (neighbors.length > bestCount) {
        bestCount = neighbors.length;
        best = id;
      }
    }
    return best;
  }

  function getLayoutOptions(site) {
    if (viewMode === 'tree') {
      const root = rootNodeId || pickDefaultRoot(site);
      const levels = root ? bfsLevels(site, root) : null;
      return {
        levelMap: levels,
        options: {
          layout: {
            hierarchical: {
              enabled: true,
              direction: 'UD',
              sortMethod: 'directed',
              levelSeparation: 120,
              nodeSpacing: 160,
              treeSpacing: 200,
              blockShifting: true,
              edgeMinimization: true,
              parentCentralization: true,
            },
          },
          physics: {
            enabled: true,
            hierarchicalRepulsion: {
              centralGravity: 0.0,
              springLength: 120,
              springConstant: 0.02,
              nodeDistance: 160,
              damping: 0.09,
              avoidOverlap: 0.5,
            },
            stabilization: { iterations: 150 },
          },
          edges: {
            smooth: { type: 'cubicBezier', forceDirection: 'vertical', roundness: 0.4 },
            shadow: { enabled: true, color: 'rgba(0,0,0,0.2)', size: 4 },
          },
        },
      };
    }

    if (viewMode === 'radial') {
      const root = rootNodeId || pickDefaultRoot(site);
      const levels = root ? bfsLevels(site, root) : null;
      return {
        levelMap: levels,
        options: {
          layout: {
            hierarchical: false,
          },
          physics: {
            enabled: true,
            solver: 'forceAtlas2Based',
            forceAtlas2Based: {
              gravitationalConstant: -120,
              centralGravity: 0.005,
              springLength: 140,
              springConstant: 0.06,
              damping: 0.4,
            },
            stabilization: { iterations: 300 },
          },
          edges: {
            smooth: { type: 'continuous' },
            shadow: { enabled: true, color: 'rgba(0,0,0,0.2)', size: 4 },
          },
        },
        radial: true,
        rootId: root,
      };
    }

    return {
      levelMap: null,
      options: {
        layout: { hierarchical: false },
        physics: {
          enabled: true,
          solver: 'forceAtlas2Based',
          forceAtlas2Based: {
            gravitationalConstant: -80,
            centralGravity: 0.01,
            springLength: 180,
            springConstant: 0.04,
            damping: 0.4,
          },
          stabilization: { iterations: 200 },
        },
        edges: {
          smooth: { type: 'continuous' },
          shadow: { enabled: true, color: 'rgba(0,0,0,0.2)', size: 4 },
        },
      },
    };
  }

  /**
   * Position nodes in concentric circles by BFS level for radial layout.
   */
  function applyRadialPositions(nodes, levels, rootId) {
    if (!levels || !rootId) return;

    const byLevel = {};
    for (const node of nodes) {
      const lvl = levels.get(node.id) || 0;
      if (!byLevel[lvl]) byLevel[lvl] = [];
      byLevel[lvl].push(node);
    }

    const ringSpacing = 200;
    for (const [lvlStr, group] of Object.entries(byLevel)) {
      const lvl = parseInt(lvlStr);
      const radius = lvl * ringSpacing;
      const count = group.length;
      for (let i = 0; i < count; i++) {
        const angle = (2 * Math.PI * i) / count - Math.PI / 2;
        group[i].x = radius * Math.cos(angle);
        group[i].y = radius * Math.sin(angle);
        group[i].fixed = { x: false, y: false };
      }
    }
  }

  function renderGraph(site) {
    const container = document.getElementById('network-graph');
    if (!container) return;

    const layoutConfig = getLayoutOptions(site);
    const nodes = [];
    const edges = [];

    for (const [id, dev] of Object.entries(site.devices)) {
      const style = deviceShape(dev.systemCapsEnabled || dev.systemCaps);
      const nodeData = {
        id,
        label: id,
        shape: style.shape,
        color: {
          background: style.color,
          border: style.color,
          highlight: { background: lighten(style.color), border: style.color },
        },
        font: { color: '#ecf0f1', size: 14, face: 'Inter, system-ui, sans-serif' },
        title: buildTooltip(dev),
      };

      if (layoutConfig.levelMap && viewMode === 'tree') {
        nodeData.level = layoutConfig.levelMap.get(id) || 0;
      }

      nodes.push(nodeData);
    }

    if (layoutConfig.radial) {
      applyRadialPositions(nodes, layoutConfig.levelMap, layoutConfig.rootId);
    }

    for (const conn of site.connections) {
      const fromLabel = cleanInterfaceLabel(conn.fromInterface);
      const toLabel = cleanInterfaceLabel(conn.toInterface);
      edges.push({
        id: connectionKey(conn.fromIdentity, conn.toIdentity),
        from: conn.fromIdentity,
        to: conn.toIdentity,
        font: { color: '#bdc3c7', size: 11, face: 'Inter, system-ui, sans-serif' },
        color: { color: '#7f8c8d', highlight: '#ecf0f1' },
        width: 2,
        title: buildEdgeTooltip(conn.fromIdentity, fromLabel, conn.toIdentity, toLabel),
        arrows: '',
      });
    }

    nodesDataSet = new vis.DataSet(nodes);
    edgesDataSet = new vis.DataSet(edges);

    const data = { nodes: nodesDataSet, edges: edgesDataSet };
    const options = {
      ...layoutConfig.options,
      interaction: {
        hover: true,
        tooltipDelay: 100,
        navigationButtons: false,
        keyboard: true,
      },
      nodes: {
        borderWidth: 2,
        size: 25,
        shadow: { enabled: true, color: 'rgba(0,0,0,0.3)', size: 8 },
      },
    };

    if (network) {
      network.destroy();
    }
    network = new vis.Network(container, data, options);

    network.on('click', (params) => {
      const currentSite = getSite(currentSiteId);
      if (!currentSite) return;
      if (params.nodes.length > 0) {
        selectedNodeId = params.nodes[0];
        showDeviceDetails(currentSite.devices[selectedNodeId]);
      } else if (params.edges.length > 0) {
        selectedNodeId = null;
        const edgeData = edgesDataSet.get(params.edges[0]);
        const conn = currentSite.connections.find(c =>
          (c.fromIdentity === edgeData.from && c.toIdentity === edgeData.to) ||
          (c.fromIdentity === edgeData.to && c.toIdentity === edgeData.from)
        );
        if (conn) showConnectionDetails(conn, currentSite);
      } else {
        selectedNodeId = null;
        hideDeviceDetails();
      }
    });

    network.on('doubleClick', (params) => {
      if (params.nodes.length > 0 && (viewMode === 'tree' || viewMode === 'radial')) {
        setRootNode(params.nodes[0]);
      }
    });
  }

  function cleanInterfaceLabel(iface) {
    if (!iface) return '?';
    return iface.replace('bridge/', '');
  }

  function buildTooltipEl(html) {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  }

  function buildTooltip(dev) {
    const lines = [
      `<b>${dev.identity}</b>`,
      dev.board ? `Board: ${dev.board}` : '',
      dev.platform ? `Platform: ${dev.platform}` : '',
      dev.version ? `Version: ${dev.version}` : '',
      dev.macAddress ? `MAC: ${dev.macAddress}` : '',
      dev.address ? `IP: ${dev.address}` : '',
      dev.address6 ? `IPv6: ${dev.address6}` : '',
      dev.systemCaps ? `Caps: ${dev.systemCaps}` : '',
    ].filter(Boolean);
    return buildTooltipEl(lines.join('<br>'));
  }

  function buildEdgeTooltip(fromId, fromIf, toId, toIf) {
    return buildTooltipEl(
      `<b>${fromId}</b> <span class="mono">${fromIf}</span>` +
      `<br>↕<br>` +
      `<b>${toId}</b> <span class="mono">${toIf}</span>`
    );
  }

  function lighten(hex) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, ((num >> 16) & 0xff) + 40);
    const g = Math.min(255, ((num >> 8) & 0xff) + 40);
    const b = Math.min(255, (num & 0xff) + 40);
    return `rgb(${r},${g},${b})`;
  }

  // ── Device detail panel ───────────────────────────────────────────

  const CLOSE_BTN_HTML = `<button class="detail-close" onclick="document.getElementById('device-details').classList.remove('visible')" title="Close">&times;</button>`;

  function showDeviceDetails(dev) {
    const panel = document.getElementById('device-details');
    if (!panel) return;

    const site = getSite(currentSiteId);
    const connections = site
      ? site.connections.filter(c => c.fromIdentity === dev.identity || c.toIdentity === dev.identity)
      : [];

    const connHtml = connections.map(c => {
      const isFrom = c.fromIdentity === dev.identity;
      const peer = isFrom ? c.toIdentity : c.fromIdentity;
      const localIf = cleanInterfaceLabel(isFrom ? c.fromInterface : c.toInterface);
      const remoteIf = cleanInterfaceLabel(isFrom ? c.toInterface : c.fromInterface);
      return `<div class="conn-item">${localIf} &harr; ${peer} (${remoteIf})</div>`;
    }).join('');

    let extraHtml = '';

    if (dev.interfaces && dev.interfaces.length > 0) {
      const ifaceRows = dev.interfaces.map(iface => {
        const status = iface.disabled ? 'X' : (iface.running ? 'R' : '-');
        const statusClass = iface.disabled ? 'iface-disabled' : (iface.running ? 'iface-running' : 'iface-down');
        const comment = iface.comment ? `<span class="iface-comment">${escHtml(iface.comment)}</span>` : '';
        return `<div class="iface-row ${statusClass}">
          <span class="iface-status">${status}</span>
          <span class="iface-name">${escHtml(iface.name)}</span>
          <span class="iface-type">${escHtml(iface.type)}</span>
          ${comment}
        </div>`;
      }).join('');
      extraHtml += `<h4>Interfaces</h4><div class="iface-list">${ifaceRows}</div>`;
    }

    if (dev.ipAddresses && dev.ipAddresses.length > 0) {
      const ipRows = dev.ipAddresses.map(ip => {
        const dyn = ip.dynamic ? ' <span class="ip-dynamic">dynamic</span>' : '';
        return `<div class="conn-item">${escHtml(ip.address)} <span class="ip-iface">on ${escHtml(ip.interface)}</span>${dyn}</div>`;
      }).join('');
      extraHtml += `<h4>IP Addresses</h4><div class="conn-list">${ipRows}</div>`;
    }

    if (dev.bridgeVlans && dev.bridgeVlans.length > 0) {
      const vlanRows = dev.bridgeVlans.map(v => {
        const tagged = v.tagged ? v.tagged.split(',').map(s => s.trim()).filter(Boolean) : [];
        const untagged = v.untagged ? v.untagged.split(',').map(s => s.trim()).filter(Boolean) : [];
        const comment = v.comment ? `<div class="vlan-comment">${escHtml(v.comment)}</div>` : '';
        let ports = '';
        if (tagged.length) ports += `<div class="vlan-ports"><span class="vlan-tag-label">T</span> ${tagged.map(p => escHtml(p)).join(', ')}</div>`;
        if (untagged.length) ports += `<div class="vlan-ports"><span class="vlan-untag-label">U</span> ${untagged.map(p => escHtml(p)).join(', ')}</div>`;
        return `<div class="vlan-item">
          <div class="vlan-header"><span class="vlan-id">VLAN ${escHtml(v.vlanIds)}</span>${comment}</div>
          ${ports}
        </div>`;
      }).join('');
      extraHtml += `<h4>Bridge VLANs</h4><div class="vlan-list">${vlanRows}</div>`;
    }

    panel.innerHTML = `
      ${CLOSE_BTN_HTML}
      <h3>${escHtml(dev.identity)}</h3>
      <div class="detail-grid">
        <span class="detail-label">Board</span><span>${escHtml(dev.board || '-')}</span>
        <span class="detail-label">Platform</span><span>${escHtml(dev.platform || '-')}</span>
        <span class="detail-label">Version</span><span>${escHtml(dev.version || '-')}</span>
        <span class="detail-label">MAC</span><span class="mono">${escHtml(dev.macAddress || '-')}</span>
        <span class="detail-label">IP</span><span class="mono">${escHtml(dev.address || '-')}</span>
        <span class="detail-label">IPv6</span><span class="mono">${escHtml(dev.address6 || '-')}</span>
        <span class="detail-label">Capabilities</span><span>${escHtml(dev.systemCaps || '-')}</span>
        <span class="detail-label">Caps Enabled</span><span>${escHtml(dev.systemCapsEnabled || '-')}</span>
        <span class="detail-label">Last Seen</span><span>${dev.lastSeen ? new Date(dev.lastSeen).toLocaleString() : '-'}</span>
      </div>
      <h4>Connections</h4>
      <div class="conn-list">${connHtml || '<em>None</em>'}</div>
      ${extraHtml}
    `;
    panel.classList.add('visible');
  }

  function showConnectionDetails(conn, site) {
    const panel = document.getElementById('device-details');
    if (!panel) return;

    const fromDev = site.devices[conn.fromIdentity] || {};
    const toDev = site.devices[conn.toIdentity] || {};
    const fromIf = cleanInterfaceLabel(conn.fromInterface);
    const toIf = cleanInterfaceLabel(conn.toInterface);

    panel.innerHTML = `
      ${CLOSE_BTN_HTML}
      <h3>Connection</h3>
      <div class="conn-detail-block">
        <div class="conn-detail-side">
          <span class="conn-detail-name">${escHtml(conn.fromIdentity)}</span>
          <span class="conn-detail-board">${escHtml(fromDev.board || '')}</span>
          <span class="conn-detail-iface mono">${escHtml(fromIf)}</span>
        </div>
        <div class="conn-detail-arrow">&updownarrow;</div>
        <div class="conn-detail-side">
          <span class="conn-detail-name">${escHtml(conn.toIdentity)}</span>
          <span class="conn-detail-board">${escHtml(toDev.board || '')}</span>
          <span class="conn-detail-iface mono">${escHtml(toIf)}</span>
        </div>
      </div>
    `;
    panel.classList.add('visible');
  }

  function hideDeviceDetails() {
    const panel = document.getElementById('device-details');
    if (panel) {
      panel.classList.remove('visible');
    }
  }

  // ── Traverse mode ────────────────────────────────────────────────

  function saveTraverseState() {
    if (!currentSiteId || !traverseState) return;
    const site = getSite(currentSiteId);
    if (!site) return;
    site.traverseState = {
      visited: [...traverseState.visited],
      pending: [...traverseState.pending.entries()],
      deadEnds: [...traverseState.deadEnds],
    };
    updateSite(site);
  }

  function loadTraverseState(site) {
    if (!site || !site.traverseState) return null;
    const s = site.traverseState;
    return {
      visited: new Set(s.visited),
      pending: new Map(s.pending),
      deadEnds: new Set(s.deadEnds),
    };
  }

  function startTraverse() {
    if (!currentSiteId) return;
    const site = getSite(currentSiteId);
    if (!site) return;

    const saved = loadTraverseState(site);
    if (saved) {
      traverseState = saved;
    } else {
      traverseState = {
        visited: new Set(),
        pending: new Map(),
        deadEnds: new Set(),
      };

      for (const [id, dev] of Object.entries(site.devices)) {
        if (dev.scanned) {
          traverseState.visited.add(id);
        }
      }

      for (const conn of site.connections) {
        for (const id of [conn.fromIdentity, conn.toIdentity]) {
          if (!traverseState.visited.has(id) && !traverseState.deadEnds.has(id) && !traverseState.pending.has(id)) {
            const dev = site.devices[id];
            if (dev) {
              traverseState.pending.set(id, {
                identity: id,
                macAddress: dev.macAddress || '',
                board: dev.board || '',
              });
            }
          }
        }
      }

      saveTraverseState();
    }

    loadSiteView();
    updateTraverseUI();
  }

  function endTraverse() {
    if (currentSiteId) {
      const site = getSite(currentSiteId);
      if (site) {
        delete site.traverseState;
        updateSite(site);
      }
    }
    traverseState = null;
    document.getElementById('traverse-lldp').value = '';
    document.getElementById('traverse-identity').value = '';
    loadSiteView();
  }

  function submitTraverseLLDP() {
    if (!currentSiteId || !traverseState) return;
    const raw = document.getElementById('traverse-lldp').value.trim();
    const identity = document.getElementById('traverse-identity').value.trim();

    if (!raw) {
      showTraverseStatus('Paste output first', true);
      return;
    }
    if (!identity) {
      showTraverseStatus('Could not detect node identity — enter it manually', true);
      return;
    }

    const sections = LLDPParser.splitCombinedOutput(raw);
    const lldpText = sections.lldp || raw;

    const result = LLDPParser.parse(lldpText);
    if (result.neighbors.length === 0) {
      showTraverseStatus('No LLDP neighbors found in the output', true);
      return;
    }

    mergeTopology(currentSiteId, identity, '', '', result.neighbors);

    if (sections.interfaces || sections.ipAddresses || sections.bridgeVlans) {
      const site2 = getSite(currentSiteId);
      if (site2 && site2.devices[identity]) {
        const dev = site2.devices[identity];
        if (sections.interfaces) dev.interfaces = LLDPParser.parseInterfaces(sections.interfaces);
        if (sections.ipAddresses) dev.ipAddresses = LLDPParser.parseIPAddresses(sections.ipAddresses);
        if (sections.bridgeVlans) dev.bridgeVlans = LLDPParser.parseBridgeVlans(sections.bridgeVlans);
        updateSite(site2);
      }
    }

    traverseState.visited.add(identity);
    traverseState.pending.delete(identity);
    traverseState.deadEnds.delete(identity);

    for (const n of result.neighbors) {
      if (!n.identity) continue;
      if (traverseState.visited.has(n.identity)) continue;
      if (traverseState.deadEnds.has(n.identity)) continue;
      if (!traverseState.pending.has(n.identity)) {
        traverseState.pending.set(n.identity, {
          identity: n.identity,
          macAddress: n.macAddress,
          board: n.board,
        });
      }
    }

    const extras = [];
    if (sections.interfaces) extras.push('interfaces');
    if (sections.ipAddresses) extras.push('IPs');
    if (sections.bridgeVlans) extras.push('VLANs');
    const extraMsg = extras.length > 0 ? ` + ${extras.join(', ')}` : '';

    document.getElementById('traverse-lldp').value = '';
    document.getElementById('traverse-identity').value = '';
    showTraverseStatus(`${identity}: ${result.neighbors.length} neighbor(s)${extraMsg}`, false);

    const site = getSite(currentSiteId);
    updateGraphForTraverse(site);
    updateTraverseUI();
    saveTraverseState();
  }

  function markDeadEnd(identity) {
    if (!traverseState) return;
    traverseState.pending.delete(identity);
    traverseState.deadEnds.add(identity);
    updateTraverseUI();
    updateTraverseNodeVisuals();
    saveTraverseState();
  }

  function showTraverseStatus(msg, isError) {
    const el = document.getElementById('traverse-status');
    el.textContent = msg;
    el.className = 'status-msg ' + (isError ? 'error' : 'success');
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  function updateTraverseUI() {
    updateTraverseProgress();
    updateTraverseQueue();
  }

  function updateTraverseProgress() {
    if (!traverseState) return;
    const v = traverseState.visited.size;
    const p = traverseState.pending.size;
    const d = traverseState.deadEnds.size;
    const total = v + p + d;
    const pct = total > 0 ? ((v + d) / total * 100) : 0;

    const fill = document.getElementById('traverse-progress-fill');
    const stats = document.getElementById('traverse-stats');
    fill.style.width = pct + '%';
    fill.className = 'progress-bar-fill' + (p === 0 && v > 0 ? ' complete' : '');

    if (total === 0) {
      stats.textContent = 'Paste LLDP data to start discovering';
    } else if (p === 0 && v > 0) {
      stats.textContent = `Done! ${v} visited` + (d > 0 ? `, ${d} dead ends` : '');
    } else {
      stats.innerHTML =
        `<span class="stat-visited">${v}</span> visited · ` +
        `<span class="stat-pending">${p}</span> pending · ` +
        `<span class="stat-dead">${d}</span> dead ends`;
    }
  }

  function updateTraverseQueue() {
    if (!traverseState) return;
    const list = document.getElementById('traverse-neighbor-list');
    const count = document.getElementById('traverse-queue-count');
    count.textContent = traverseState.pending.size;

    if (traverseState.pending.size === 0) {
      list.innerHTML = traverseState.visited.size > 0
        ? '<div class="empty-state">All reachable neighbors visited</div>'
        : '<div class="empty-state">Paste LLDP data to discover neighbors</div>';
      return;
    }

    list.innerHTML = Array.from(traverseState.pending.values()).map(n => {
      const cmd = `/tool/mac-telnet ${n.macAddress}`;
      return `<div class="traverse-neighbor-item" data-identity="${escHtml(n.identity)}">
        <div class="traverse-neighbor-header">
          <span class="traverse-neighbor-name">${escHtml(n.identity)}</span>
          <span class="traverse-neighbor-board">${escHtml(n.board || '')}</span>
        </div>
        <div class="traverse-neighbor-actions">
          <button class="btn-copy-cmd" data-cmd="${escHtml(cmd)}" title="Copy command">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            <span class="cmd-text">${escHtml(cmd)}</span>
          </button>
          <button class="btn-dead-end" data-identity="${escHtml(n.identity)}">Dead End</button>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.btn-copy-cmd').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(btn.dataset.cmd).then(() => {
          const t = btn.querySelector('.cmd-text');
          const orig = t.textContent;
          t.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => { t.textContent = orig; btn.classList.remove('copied'); }, 1500);
        });
      });
    });

    list.querySelectorAll('.btn-dead-end').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        markDeadEnd(btn.dataset.identity);
      });
    });

    list.querySelectorAll('.traverse-neighbor-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.identity;
        if (network) {
          network.selectNodes([id]);
          network.focus(id, { scale: 1.2, animation: true });
        }
        const site = getSite(currentSiteId);
        if (site && site.devices[id]) showDeviceDetails(site.devices[id]);
      });
    });
  }

  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function updateGraphForTraverse(site) {
    populateRootSelect(site);
    showViewToolbar(Object.keys(site.devices).length > 0);

    if (viewMode !== 'network') {
      renderCurrentView(site);
      return;
    }

    if (!network || !nodesDataSet) {
      renderGraph(site);
      if (showEdgeLabels) toggleEdgeLabels(true);
      if (traverseState) updateTraverseNodeVisuals();
      return;
    }

    for (const [id, dev] of Object.entries(site.devices)) {
      const style = deviceShape(dev.systemCapsEnabled || dev.systemCaps);
      const nodeData = {
        id,
        label: id,
        shape: style.shape,
        color: {
          background: style.color,
          border: style.color,
          highlight: { background: lighten(style.color), border: style.color },
        },
        font: { color: '#ecf0f1', size: 14, face: 'Inter, system-ui, sans-serif' },
        title: buildTooltip(dev),
      };
      if (nodesDataSet.get(id)) {
        nodesDataSet.update(nodeData);
      } else {
        nodesDataSet.add(nodeData);
      }
    }

    const newEdges = {};
    for (const conn of site.connections) {
      const eid = connectionKey(conn.fromIdentity, conn.toIdentity);
      const fromLabel = cleanInterfaceLabel(conn.fromInterface);
      const toLabel = cleanInterfaceLabel(conn.toInterface);
      newEdges[eid] = {
        id: eid,
        from: conn.fromIdentity,
        to: conn.toIdentity,
        font: { color: '#bdc3c7', size: 11, face: 'Inter, system-ui, sans-serif' },
        color: { color: '#7f8c8d', highlight: '#ecf0f1' },
        width: 2,
        title: buildEdgeTooltip(conn.fromIdentity, fromLabel, conn.toIdentity, toLabel),
        arrows: '',
      };
    }

    const existingEdgeIds = edgesDataSet.getIds();
    for (const eid of existingEdgeIds) {
      if (!newEdges[eid]) edgesDataSet.remove(eid);
    }
    for (const [eid, edgeData] of Object.entries(newEdges)) {
      if (edgesDataSet.get(eid)) {
        edgesDataSet.update(edgeData);
      } else {
        edgesDataSet.add(edgeData);
      }
    }

    updateTraverseNodeVisuals();
  }

  function updateTraverseNodeVisuals() {
    if (!nodesDataSet || !traverseState) return;
    const site = getSite(currentSiteId);
    if (!site) return;

    const updates = [];
    for (const [id, dev] of Object.entries(site.devices)) {
      const style = deviceShape(dev.systemCapsEnabled || dev.systemCaps);
      let borderColor = style.color;
      let borderWidth = 2;
      let opacity = 1;

      if (traverseState.visited.has(id)) {
        borderColor = '#2ecc71';
        borderWidth = 4;
      } else if (traverseState.deadEnds.has(id)) {
        borderColor = '#e74c3c';
        borderWidth = 4;
        opacity = 0.5;
      } else if (traverseState.pending.has(id)) {
        borderColor = '#f39c12';
        borderWidth = 3;
      }

      updates.push({
        id,
        borderWidth,
        opacity,
        color: {
          background: style.color,
          border: borderColor,
          highlight: { background: lighten(style.color), border: borderColor },
        },
      });
    }

    if (updates.length > 0) nodesDataSet.update(updates);
  }

  // ── Text tree rendering ──────────────────────────────────────────

  /**
   * Build a tree structure from the site data rooted at rootId.
   * Returns { id, dev, children: [{ id, dev, localIf, remoteIf, children }] }
   */
  function buildTree(site, rootId) {
    const adj = {};
    for (const conn of site.connections) {
      if (!adj[conn.fromIdentity]) adj[conn.fromIdentity] = [];
      if (!adj[conn.toIdentity]) adj[conn.toIdentity] = [];
      adj[conn.fromIdentity].push({
        peer: conn.toIdentity,
        localIf: conn.fromInterface,
        remoteIf: conn.toInterface,
      });
      adj[conn.toIdentity].push({
        peer: conn.fromIdentity,
        localIf: conn.toInterface,
        remoteIf: conn.fromInterface,
      });
    }

    const visited = new Set();
    function walk(id) {
      visited.add(id);
      const dev = site.devices[id] || {};
      const children = [];
      const neighbors = adj[id] || [];

      neighbors.sort((a, b) => a.localIf.localeCompare(b.localIf));

      for (const n of neighbors) {
        if (visited.has(n.peer)) continue;
        const child = walk(n.peer);
        child.localIf = cleanInterfaceLabel(n.localIf);
        child.remoteIf = cleanInterfaceLabel(n.remoteIf);
        children.push(child);
      }
      return { id, dev, children };
    }

    return walk(rootId);
  }

  function renderTextTree(site) {
    const container = document.getElementById('text-tree-output');
    if (!container) return;

    const root = rootNodeId || pickDefaultRoot(site);
    if (!root) {
      container.textContent = 'No devices to display';
      return;
    }

    const tree = buildTree(site, root);
    const lines = [];

    function renderNode(node, prefix, isRoot) {
      const board = node.dev.board || '';
      const name = node.id;

      if (isRoot) {
        const header = `[ ${name} ]`;
        const boardLine = board ? `  ${board}` : '';
        lines.push('');
        lines.push(`${prefix}${header}`);
        if (boardLine) lines.push(`${prefix}${boardLine}`);
      }

      if (node.children.length === 0) return;

      const separator = '─'.repeat(Math.max(60, longestChildLine(node) + 4));
      lines.push(`${prefix}${separator}`);

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const isLast = i === node.children.length - 1;
        const branch = isLast ? '└── ' : '├── ';
        const cont = isLast ? '    ' : '│   ';

        const childBoard = child.dev.board ? ` (${child.dev.board})` : '';
        const remotePart = child.remoteIf ? `  remote: ${child.remoteIf}` : '';
        const localPad = padRight(child.localIf || '?', maxLocalIfLen(node));
        const namePad = padRight(child.id + childBoard, maxNameBoardLen(node));

        lines.push(`${prefix}${branch}${localPad}  →  ${namePad}${remotePart}`);

        if (child.children.length > 0) {
          renderNode(child, prefix + cont, false);
        }
      }
    }

    function padRight(str, len) {
      return str + ' '.repeat(Math.max(0, len - str.length));
    }

    function maxLocalIfLen(node) {
      let max = 0;
      for (const c of node.children) {
        const l = (c.localIf || '?').length;
        if (l > max) max = l;
      }
      return max;
    }

    function maxNameBoardLen(node) {
      let max = 0;
      for (const c of node.children) {
        const board = c.dev.board ? ` (${c.dev.board})` : '';
        const l = (c.id + board).length;
        if (l > max) max = l;
      }
      return max;
    }

    function longestChildLine(node) {
      let max = 0;
      for (const c of node.children) {
        const board = c.dev.board ? ` (${c.dev.board})` : '';
        const remote = c.remoteIf ? `  remote: ${c.remoteIf}` : '';
        const l = 4 + (c.localIf || '?').length + 5 + c.id.length + board.length + remote.length;
        if (l > max) max = l;
      }
      return max;
    }

    function renderSubtreeHeader(node, prefix) {
      if (!node.children.length) return;
      const board = node.dev.board || '';
      lines.push('');
      const header = `[ ${node.id} ]`;
      const boardLine = board ? `  ${board}` : '';
      lines.push(`${prefix}${header}`);
      if (boardLine) lines.push(`${prefix}${boardLine}`);
    }

    function getPortVlanSummary(dev, portName) {
      if (!dev.bridgeVlans || dev.bridgeVlans.length === 0) return '';
      const clean = cleanInterfaceLabel(portName);
      const vlans = [];
      for (const v of dev.bridgeVlans) {
        const tagged = v.tagged ? v.tagged.split(',').map(s => cleanInterfaceLabel(s.trim())).filter(Boolean) : [];
        const untagged = v.untagged ? v.untagged.split(',').map(s => cleanInterfaceLabel(s.trim())).filter(Boolean) : [];
        if (tagged.includes(clean)) vlans.push(`T:${v.vlanIds}`);
        if (untagged.includes(clean)) vlans.push(`U:${v.vlanIds}`);
      }
      return vlans.length ? `  [${vlans.join(' ')}]` : '';
    }

    function renderFull(node, prefix, isRoot) {
      const board = node.dev.board || '';
      const name = node.id;

      const header = `[ ${name} ]`;
      const boardLine = board ? `  ${board}` : '';
      lines.push('');
      lines.push(`${prefix}${header}`);
      if (boardLine) lines.push(`${prefix}${boardLine}`);

      const dev = node.dev;
      if (dev.ipAddresses && dev.ipAddresses.length > 0) {
        const ips = dev.ipAddresses.map(ip => `${ip.address} on ${ip.interface}${ip.dynamic ? ' (dyn)' : ''}`);
        lines.push(`${prefix}  IP: ${ips.join(', ')}`);
      }

      if (node.children.length === 0) {
        if (dev.bridgeVlans && dev.bridgeVlans.length > 0) {
          renderVlanBlock(dev, prefix);
        } else {
          lines.push(`${prefix}  (no further connections)`);
        }
        return;
      }

      const separator = '─'.repeat(Math.max(60, longestChildLine(node) + 4));
      lines.push(`${prefix}${separator}`);

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const childBoard = child.dev.board ? ` (${child.dev.board})` : '';
        const remotePart = child.remoteIf ? `  remote: ${child.remoteIf}` : '';
        const localPad = padRight(child.localIf || '?', maxLocalIfLen(node));
        const namePad = padRight(child.id + childBoard, maxNameBoardLen(node));
        const vlanPart = getPortVlanSummary(dev, child.localIf || '');

        lines.push(`${prefix}${localPad}  →  ${namePad}${remotePart}${vlanPart}`);
      }

      if (dev.bridgeVlans && dev.bridgeVlans.length > 0) {
        renderVlanBlock(dev, prefix);
      }

      for (const child of node.children) {
        if (child.children.length > 0) {
          renderFull(child, prefix, false);
        }
      }
    }

    function renderVlanBlock(dev, prefix) {
      lines.push(`${prefix}  VLANs:`);
      for (const v of dev.bridgeVlans) {
        const tagged = v.tagged ? v.tagged.split(',').map(s => s.trim()).filter(Boolean) : [];
        const untagged = v.untagged ? v.untagged.split(',').map(s => s.trim()).filter(Boolean) : [];
        const comment = v.comment ? ` (${v.comment})` : '';
        let portStr = '';
        if (tagged.length) portStr += ` T:${tagged.join(',')}`;
        if (untagged.length) portStr += ` U:${untagged.join(',')}`;
        lines.push(`${prefix}    ${v.vlanIds}${comment}${portStr}`);
      }
    }

    renderFull(tree, '', true);

    // Count unreachable nodes
    const treeNodes = new Set();
    function collectIds(n) { treeNodes.add(n.id); n.children.forEach(collectIds); }
    collectIds(tree);
    const unreachable = Object.keys(site.devices).filter(id => !treeNodes.has(id));

    if (unreachable.length > 0) {
      lines.push('');
      lines.push('');
      lines.push('── Unreachable from root ──────────────────────────────────');
      for (const id of unreachable) {
        const dev = site.devices[id];
        const board = dev.board ? ` (${dev.board})` : '';
        lines.push(`  ${id}${board}`);
      }
    }

    container.textContent = lines.join('\n');
  }

  // ── Table view rendering ─────────────────────────────────────────

  let tableSortCol = 'identity';
  let tableSortAsc = true;

  const TABLE_COLS = [
    { key: 'identity', label: 'Identity' },
    { key: 'board', label: 'Board' },
    { key: 'address', label: 'IP' },
    { key: 'macAddress', label: 'MAC' },
    { key: 'version', label: 'Version' },
    { key: 'systemCaps', label: 'Capabilities' },
    { key: 'connections', label: 'Conn.' },
    { key: 'lastSeen', label: 'Last Seen' },
  ];

  function renderTable(site) {
    const table = document.getElementById('device-table');
    if (!table) return;

    const adj = buildAdjacency(site);
    const devices = Object.values(site.devices).map(d => ({
      ...d,
      connections: (adj[d.identity] || []).length,
    }));

    devices.sort((a, b) => {
      let va = a[tableSortCol] ?? '';
      let vb = b[tableSortCol] ?? '';
      if (tableSortCol === 'connections') {
        return tableSortAsc ? va - vb : vb - va;
      }
      if (tableSortCol === 'lastSeen') {
        return tableSortAsc
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va));
      }
      va = String(va).toLowerCase();
      vb = String(vb).toLowerCase();
      return tableSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });

    const thead = table.querySelector('thead tr');
    thead.innerHTML = TABLE_COLS.map(col => {
      const sorted = tableSortCol === col.key;
      const arrow = sorted ? (tableSortAsc ? ' ▲' : ' ▼') : ' ▲';
      return `<th data-col="${col.key}" class="${sorted ? 'sorted' : ''}">${col.label}<span class="sort-arrow">${arrow}</span></th>`;
    }).join('');

    thead.querySelectorAll('th').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (tableSortCol === col) {
          tableSortAsc = !tableSortAsc;
        } else {
          tableSortCol = col;
          tableSortAsc = true;
        }
        renderTable(site);
        applySearchFilter();
      });
    });

    const tbody = table.querySelector('tbody');
    const searchTerm = (document.getElementById('search-input').value || '').toLowerCase();

    tbody.innerHTML = devices.map(d => {
      const style = deviceShape(d.systemCapsEnabled || d.systemCaps);
      const matchesSearch = !searchTerm || deviceMatchesSearch(d, searchTerm);
      return `<tr data-identity="${escHtml(d.identity)}" class="${matchesSearch ? '' : 'search-dim'}">
        <td><span class="cap-dot" style="background:${style.color}"></span>${escHtml(d.identity)}</td>
        <td>${escHtml(d.board || '-')}</td>
        <td class="mono-cell">${escHtml(d.address || '-')}</td>
        <td class="mono-cell">${escHtml(d.macAddress || '-')}</td>
        <td>${escHtml(d.version || '-')}</td>
        <td>${escHtml(d.systemCaps || '-')}</td>
        <td>${d.connections}</td>
        <td>${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '-'}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', () => {
        const id = tr.dataset.identity;
        if (site.devices[id]) showDeviceDetails(site.devices[id]);
      });
    });
  }

  function exportCSV(site) {
    const adj = buildAdjacency(site);
    const header = TABLE_COLS.map(c => c.label).join(',');
    const rows = Object.values(site.devices).map(d => {
      const conns = (adj[d.identity] || []).length;
      return [
        d.identity, d.board, d.address, d.macAddress,
        d.version, d.systemCaps, conns,
        d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '',
      ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',');
    });
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lldpviz-devices.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Matrix view rendering ───────────────────────────────────────

  function renderMatrix(site) {
    const container = document.getElementById('matrix-scroll');
    if (!container) return;

    const ids = Object.keys(site.devices).sort();
    if (ids.length === 0) {
      container.innerHTML = '<div class="empty-graph">No devices</div>';
      return;
    }

    const connLookup = {};
    for (const conn of site.connections) {
      const key = connectionKey(conn.fromIdentity, conn.toIdentity);
      connLookup[key] = conn;
    }

    let html = '<table class="matrix-table"><thead><tr>';
    html += '<th class="matrix-corner"></th>';
    for (const id of ids) {
      html += `<th class="matrix-col-header">${escHtml(id)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const rowId of ids) {
      html += `<tr><th class="matrix-row-header">${escHtml(rowId)}</th>`;
      for (const colId of ids) {
        if (rowId === colId) {
          html += '<td class="matrix-self">-</td>';
          continue;
        }
        const key = connectionKey(rowId, colId);
        const conn = connLookup[key];
        if (conn) {
          const isFrom = conn.fromIdentity === rowId;
          const localIf = cleanInterfaceLabel(isFrom ? conn.fromInterface : conn.toInterface);
          const remoteIf = cleanInterfaceLabel(isFrom ? conn.toInterface : conn.fromInterface);
          html += `<td class="matrix-connected" title="${escHtml(localIf)} ↔ ${escHtml(remoteIf)}">${escHtml(localIf)}</td>`;
        } else {
          html += '<td></td>';
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // ── Port-map view rendering ─────────────────────────────────────

  /**
   * Build a lookup: portName -> [{vlan, mode:'T'|'U'}] from bridgeVlans data.
   */
  function buildPortVlanMap(bridgeVlans) {
    const map = {};
    for (const v of bridgeVlans) {
      const tagged = v.tagged ? v.tagged.split(',').map(s => s.trim()).filter(Boolean) : [];
      const untagged = v.untagged ? v.untagged.split(',').map(s => s.trim()).filter(Boolean) : [];
      for (const p of tagged) {
        const key = cleanInterfaceLabel(p);
        if (!map[key]) map[key] = [];
        map[key].push({ vlan: v.vlanIds, mode: 'T' });
      }
      for (const p of untagged) {
        const key = cleanInterfaceLabel(p);
        if (!map[key]) map[key] = [];
        map[key].push({ vlan: v.vlanIds, mode: 'U' });
      }
    }
    return map;
  }

  function renderPortMap(site) {
    const container = document.getElementById('portmap-scroll');
    if (!container) return;

    const ids = Object.keys(site.devices).sort();
    if (ids.length === 0) {
      container.innerHTML = '<div class="empty-graph">No devices</div>';
      return;
    }

    const connByDevice = {};
    for (const conn of site.connections) {
      if (!connByDevice[conn.fromIdentity]) connByDevice[conn.fromIdentity] = [];
      if (!connByDevice[conn.toIdentity]) connByDevice[conn.toIdentity] = [];
      connByDevice[conn.fromIdentity].push({
        localIf: conn.fromInterface,
        remoteIf: conn.toInterface,
        peer: conn.toIdentity,
      });
      connByDevice[conn.toIdentity].push({
        localIf: conn.toInterface,
        remoteIf: conn.fromInterface,
        peer: conn.fromIdentity,
      });
    }

    let html = '';
    for (const id of ids) {
      const dev = site.devices[id];
      const conns = connByDevice[id] || [];
      const ifaces = dev.interfaces || [];

      const portSet = new Set();
      for (const c of conns) {
        if (c.localIf) portSet.add(c.localIf);
      }
      for (const iface of ifaces) {
        if (iface.name) portSet.add(iface.name);
      }

      const knownPorts = inferPorts(dev.board, portSet);

      const connMap = {};
      for (const c of conns) {
        const key = cleanInterfaceLabel(c.localIf);
        connMap[key] = c;
      }

      const ifaceStatusMap = {};
      for (const iface of ifaces) {
        ifaceStatusMap[cleanInterfaceLabel(iface.name)] = iface;
      }

      const vlanMap = buildPortVlanMap(dev.bridgeVlans || []);

      html += `<div class="portmap-device">
        <div class="portmap-device-header">
          <span class="portmap-device-name">${escHtml(id)}</span>
          <span class="portmap-device-board">${escHtml(dev.board || '')}</span>
        </div>
        <div class="portmap-ports">`;

      for (const port of knownPorts) {
        const cleanPort = cleanInterfaceLabel(port);
        const conn = connMap[cleanPort];
        const cls = conn ? 'port-connected' : 'port-unused';
        const peerLabel = conn ? escHtml(conn.peer) : '';
        const shortPort = cleanPort.replace(/^sfp-sfpplus/, 'sfp+').replace(/^ether/, 'e');

        const portVlans = vlanMap[cleanPort] || [];
        const vlanStr = portVlans.map(v => `${v.mode}${v.vlan}`).join(' ');
        const vlanTooltip = portVlans.length
          ? '\nVLANs: ' + portVlans.map(v => `${v.vlan}(${v.mode})`).join(', ')
          : '';

        const tooltip = conn
          ? `${cleanPort} → ${conn.peer} (${cleanInterfaceLabel(conn.remoteIf)})${vlanTooltip}`
          : `${cleanPort}${vlanTooltip}`;

        const peerAttr = conn ? `data-peer="${escHtml(conn.peer)}" data-peer-port="${escHtml(cleanInterfaceLabel(conn.remoteIf))}"` : '';
        html += `<div class="portmap-port ${cls}" data-port="${escHtml(cleanPort)}" data-device="${escHtml(id)}" ${peerAttr}>
          <span class="port-num">${escHtml(shortPort)}</span>
          <span class="port-peer">${peerLabel}</span>
          ${portVlans.length ? `<span class="port-vlans">${escHtml(vlanStr)}</span>` : ''}
          <div class="portmap-port-tooltip">${escHtml(tooltip)}</div>
        </div>`;
      }

      html += '</div></div>';
    }
    container.innerHTML = html;

    container.querySelectorAll('.portmap-port.port-connected').forEach(el => {
      el.addEventListener('click', () => {
        container.querySelectorAll('.portmap-port').forEach(p => p.classList.remove('port-highlight'));
        el.classList.add('port-highlight');

        const peerDev = el.dataset.peer;
        const peerPort = el.dataset.peerPort;
        if (peerDev && peerPort) {
          const peerEl = container.querySelector(
            `.portmap-port[data-device="${CSS.escape(peerDev)}"][data-port="${CSS.escape(peerPort)}"]`
          );
          if (peerEl) {
            peerEl.classList.add('port-highlight');
            peerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }

        const devId = el.dataset.device;
        const dev = site.devices[devId];
        if (dev) showDeviceDetails(dev);
      });
    });

    container.addEventListener('click', (e) => {
      if (!e.target.closest('.portmap-port')) {
        container.querySelectorAll('.portmap-port').forEach(p => p.classList.remove('port-highlight'));
      }
    });
  }

  function inferPorts(board, knownPorts) {
    const ports = [];
    const b = (board || '').toLowerCase();

    let sfpCount = 0, etherCount = 0;
    if (b.includes('crs326-24s+2q+')) { sfpCount = 24; }
    else if (b.includes('crs326-24g-2s+')) { etherCount = 24; sfpCount = 2; }
    else if (b.includes('crs310-8g+2s+') || b.includes('crs310-8g\\+2s\\+')) { etherCount = 8; sfpCount = 2; }
    else if (b.includes('crs328')) { etherCount = 24; sfpCount = 4; }
    else if (b.includes('crs312')) { sfpCount = 12; }
    else if (b.includes('ccr2004-16g-2s+')) { etherCount = 16; sfpCount = 2; }
    else if (b.includes('rb2011')) { etherCount = 10; sfpCount = 1; }
    else if (b.includes('rb750') || b.includes('hex')) { etherCount = 5; }

    if (sfpCount === 0 && etherCount === 0) {
      return Array.from(knownPorts).sort();
    }

    for (let i = 1; i <= sfpCount; i++) {
      ports.push(`sfp-sfpplus${i}`);
    }
    for (let i = 1; i <= etherCount; i++) {
      ports.push(`ether${i}`);
    }

    for (const p of knownPorts) {
      const clean = cleanInterfaceLabel(p);
      if (!ports.some(pp => cleanInterfaceLabel(pp) === clean)) {
        ports.push(p);
      }
    }

    return ports;
  }

  // ── Search / filter ─────────────────────────────────────────────

  let searchTerm = '';

  function deviceMatchesSearch(dev, term) {
    if (!term) return true;
    const fields = [
      dev.identity, dev.board, dev.address, dev.address6,
      dev.macAddress, dev.version, dev.systemCaps, dev.platform,
    ];
    return fields.some(f => f && f.toLowerCase().includes(term));
  }

  function applySearchFilter() {
    const term = (document.getElementById('search-input').value || '').toLowerCase();
    searchTerm = term;
    const site = getSite(currentSiteId);
    if (!site) return;

    if (viewMode === 'network' || viewMode === 'tree' || viewMode === 'radial') {
      if (nodesDataSet) {
        const updates = [];
        for (const [id, dev] of Object.entries(site.devices)) {
          const match = deviceMatchesSearch(dev, term);
          updates.push({
            id,
            opacity: match || !term ? 1 : 0.15,
            font: {
              color: match || !term ? '#ecf0f1' : '#3a3d4a',
              size: 14,
              face: 'Inter, system-ui, sans-serif',
            },
          });
        }
        nodesDataSet.update(updates);
      }
    } else if (viewMode === 'table') {
      document.querySelectorAll('#device-table tbody tr').forEach(tr => {
        const id = tr.dataset.identity;
        const dev = site.devices[id];
        const match = dev && deviceMatchesSearch(dev, term);
        tr.classList.toggle('search-dim', !match && !!term);
      });
    }
  }

  // ── Edge labels toggle ──────────────────────────────────────────

  let showEdgeLabels = false;

  function toggleEdgeLabels(show) {
    showEdgeLabels = show;
    if (!edgesDataSet) return;
    const site = getSite(currentSiteId);
    if (!site) return;

    const updates = [];
    for (const conn of site.connections) {
      const eid = connectionKey(conn.fromIdentity, conn.toIdentity);
      const fromLabel = cleanInterfaceLabel(conn.fromInterface);
      const toLabel = cleanInterfaceLabel(conn.toInterface);
      updates.push({
        id: eid,
        label: show ? `${fromLabel} ↔ ${toLabel}` : '',
      });
    }
    edgesDataSet.update(updates);
  }

  // ── View mode switching ──────────────────────────────────────────

  const ALL_VIEW_CONTAINERS = ['network-graph', 'text-view', 'table-view', 'matrix-view', 'portmap-view'];

  function showViewContainer(activeId) {
    for (const id of ALL_VIEW_CONTAINERS) {
      const el = document.getElementById(id);
      if (el) el.style.display = id === activeId ? (id === 'network-graph' ? '' : 'flex') : 'none';
    }
  }

  function getContainerForMode(mode) {
    const map = { network: 'network-graph', tree: 'network-graph', radial: 'network-graph',
      text: 'text-view', table: 'table-view', matrix: 'matrix-view', portmap: 'portmap-view' };
    return map[mode] || 'network-graph';
  }

  function setViewMode(mode) {
    viewMode = mode;
    document.querySelectorAll('.view-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const needsRoot = mode === 'tree' || mode === 'radial' || mode === 'text';
    const rootSelector = document.getElementById('root-selector');
    if (rootSelector) rootSelector.style.display = needsRoot ? 'flex' : 'none';

    const isGraphMode = mode === 'network' || mode === 'tree' || mode === 'radial';
    const edgeLabelToggle = document.getElementById('edge-label-toggle');
    if (edgeLabelToggle) edgeLabelToggle.style.display = isGraphMode ? 'flex' : 'none';

    showViewContainer(getContainerForMode(mode));

    const site = getSite(currentSiteId);
    if (site && Object.keys(site.devices).length > 0) {
      if (needsRoot && !rootNodeId) {
        rootNodeId = pickDefaultRoot(site);
        syncRootSelect();
      }
      renderCurrentView(site);
    }
  }

  function renderCurrentView(site) {
    if (viewMode === 'text') {
      renderTextTree(site);
    } else if (viewMode === 'table') {
      renderTable(site);
    } else if (viewMode === 'matrix') {
      renderMatrix(site);
    } else if (viewMode === 'portmap') {
      renderPortMap(site);
    } else {
      renderGraph(site);
      if (showEdgeLabels) toggleEdgeLabels(true);
      if (traverseState) updateTraverseNodeVisuals();
    }
  }

  function setRootNode(nodeId) {
    rootNodeId = nodeId;
    syncRootSelect();
    const site = getSite(currentSiteId);
    if (site && Object.keys(site.devices).length > 0) {
      renderCurrentView(site);
    }
  }

  function syncRootSelect() {
    const sel = document.getElementById('root-node-select');
    if (sel) sel.value = rootNodeId || '';
  }

  function populateRootSelect(site) {
    const sel = document.getElementById('root-node-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Auto (most connected) --</option>';
    if (!site) return;

    const adj = buildAdjacency(site);
    const sorted = Object.keys(site.devices).sort((a, b) => {
      const diff = (adj[b] || []).length - (adj[a] || []).length;
      return diff !== 0 ? diff : a.localeCompare(b);
    });

    for (const id of sorted) {
      const opt = document.createElement('option');
      opt.value = id;
      const connCount = (adj[id] || []).length;
      opt.textContent = `${id} (${connCount} conn.)`;
      if (id === rootNodeId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function showViewToolbar(visible) {
    const toolbar = document.getElementById('view-toolbar');
    if (toolbar) toolbar.style.display = visible ? 'flex' : 'none';
  }

  // ── Share API ───────────────────────────────────────────────────

  function buildSiteExportData() {
    if (!currentSiteId) return null;
    const site = getSite(currentSiteId);
    if (!site) return null;
    const data = {
      name: site.name,
      devices: site.devices,
      connections: site.connections,
    };
    if (site.traverseState) data.traverseState = site.traverseState;
    return data;
  }

  async function shareSite() {
    const data = buildSiteExportData();
    if (!data) return;

    try {
      const resp = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();

      sharedSiteId = result.uuid;
      sharedRevision = result.revision;
      sharedRevisions = [{ revision: 1, created_at: new Date().toISOString() }];

      const site = getSite(currentSiteId);
      if (site) {
        site._sharedUuid = result.uuid;
        updateSite(site);
      }

      const shareUrl = `${location.origin}/?share=${result.uuid}`;
      await navigator.clipboard.writeText(shareUrl);

      updateShareUI();
      showStatus('Link copied to clipboard!', false);
    } catch (err) {
      showStatus('Share failed: ' + err.message, true);
    }
  }

  async function saveRevision() {
    if (!sharedSiteId) return;
    const data = buildSiteExportData();
    if (!data) return;

    try {
      const resp = await fetch(`/api/share/${sharedSiteId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();

      sharedRevision = result.revision;
      sharedRevisions.unshift({
        revision: result.revision,
        created_at: new Date().toISOString(),
      });

      updateShareUI();
      showStatus(`Saved revision ${result.revision}`, false);
    } catch (err) {
      showStatus('Save failed: ' + err.message, true);
    }
  }

  async function loadSharedSite(uuid, rev) {
    try {
      const url = rev ? `/api/share/${uuid}?rev=${rev}` : `/api/share/${uuid}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();

      sharedSiteId = result.uuid;
      sharedRevision = result.revision;
      sharedRevisions = result.revisions || [];

      const data = result.data;
      const siteName = data.name || 'Shared Site';

      const sites = loadSites();
      let existingId = null;
      for (const [id, s] of Object.entries(sites)) {
        if (s._sharedUuid === uuid) {
          existingId = id;
          break;
        }
      }

      const targetId = existingId || ('site_' + Date.now());
      const site = {
        id: targetId,
        name: siteName,
        devices: data.devices || {},
        connections: data.connections || [],
        _sharedUuid: uuid,
      };
      if (data.traverseState) site.traverseState = data.traverseState;

      sites[targetId] = site;
      saveSites(sites);

      currentSiteId = targetId;
      localStorage.setItem(SITE_ID_KEY, targetId);
      if (traverseState) traverseState = null;
      refreshSiteSelector();
      loadSiteView();
      updateShareUI();
    } catch (err) {
      showStatus('Could not load shared site: ' + err.message, true);
    }
  }

  async function switchRevision(rev) {
    if (!sharedSiteId) return;
    await loadSharedSite(sharedSiteId, rev);
  }

  function updateShareUI() {
    const shareControls = document.getElementById('share-controls');
    const btnShare = document.getElementById('btn-share-site');
    const btnSave = document.getElementById('btn-save-revision');
    const revSelect = document.getElementById('revision-select');

    if (btnShare) btnShare.disabled = !currentSiteId;

    if (sharedSiteId && currentSiteId) {
      shareControls.style.display = 'flex';

      revSelect.innerHTML = '';
      for (const r of sharedRevisions) {
        const opt = document.createElement('option');
        opt.value = r.revision;
        const d = new Date(r.created_at);
        opt.textContent = `Rev ${r.revision} — ${d.toLocaleString()}`;
        if (r.revision === sharedRevision) opt.selected = true;
        revSelect.appendChild(opt);
      }
      revSelect.style.display = sharedRevisions.length > 1 ? '' : 'none';
    } else {
      shareControls.style.display = 'none';
    }
  }

  function checkUrlForShare() {
    const params = new URLSearchParams(location.search);
    const shareId = params.get('share');
    if (shareId) {
      loadSharedSite(shareId);
    }
  }

  // ── Modals ──────────────────────────────────────────────────────

  function openHelp() {
    document.getElementById('help-modal').style.display = 'flex';
  }

  function closeHelp() {
    document.getElementById('help-modal').style.display = 'none';
  }

  function openAbout() {
    document.getElementById('about-modal').style.display = 'flex';
  }

  function closeAbout() {
    document.getElementById('about-modal').style.display = 'none';
  }

  // ── JSON Export / Import ───────────────────────────────────────

  function exportSite() {
    if (!currentSiteId) return;
    const site = getSite(currentSiteId);
    if (!site) return;

    const exportData = {
      name: site.name,
      devices: site.devices,
      connections: site.connections,
    };
    if (site.traverseState) {
      exportData.traverseState = site.traverseState;
    }

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lldpviz-${site.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importSite(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.name || !data.devices) {
          alert('Invalid JSON file: missing "name" and/or "devices" fields.');
          return;
        }

        const siteName = data.name;
        const sites = loadSites();
        let existingId = null;
        for (const [id, s] of Object.entries(sites)) {
          if (s.name === siteName) {
            existingId = id;
            break;
          }
        }

        let targetId;
        if (existingId) {
          if (!confirm(`A site named "${siteName}" already exists. Do you want to overwrite it?`)) {
            return;
          }
          targetId = existingId;
        } else {
          targetId = 'site_' + Date.now();
        }

        const site = {
          id: targetId,
          name: siteName,
          devices: data.devices || {},
          connections: data.connections || [],
        };
        if (data.traverseState) {
          site.traverseState = data.traverseState;
        }

        sites[targetId] = site;
        saveSites(sites);

        currentSiteId = targetId;
        localStorage.setItem(SITE_ID_KEY, targetId);
        if (traverseState) traverseState = null;
        refreshSiteSelector();
        loadSiteView();
        showStatus(`Site "${siteName}" imported`, false);
      } catch (err) {
        alert('Could not read JSON file: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  function updateExportButton() {
    const btn = document.getElementById('btn-export-site');
    if (btn) btn.disabled = !currentSiteId;
  }

  // ── UI wiring ─────────────────────────────────────────────────────

  function refreshSiteSelector() {
    const sel = document.getElementById('site-select');
    const sites = loadSites();
    sel.innerHTML = '<option value="">-- Select site --</option>';
    for (const [id, site] of Object.entries(sites)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = site.name;
      if (id === currentSiteId) opt.selected = true;
      sel.appendChild(opt);
    }
    updateDeleteButton();
  }

  function refreshDeviceList() {
    const list = document.getElementById('device-list');
    if (!list) return;
    const site = getSite(currentSiteId);
    if (!site) {
      list.innerHTML = '<div class="empty-state">No site selected</div>';
      return;
    }
    const devices = Object.values(site.devices);
    if (devices.length === 0) {
      list.innerHTML = '<div class="empty-state">No devices yet</div>';
      return;
    }
    list.innerHTML = devices.map(d => {
      const style = deviceShape(d.systemCapsEnabled || d.systemCaps);
      return `<div class="device-item" data-identity="${d.identity}">
        <span class="device-dot" style="background:${style.color}"></span>
        <span class="device-name">${d.identity}</span>
        <span class="device-board">${d.board || ''}</span>
      </div>`;
    }).join('');

    list.querySelectorAll('.device-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.identity;
        if (network) {
          network.selectNodes([id]);
          network.focus(id, { scale: 1.2, animation: true });
        }
        showDeviceDetails(site.devices[id]);
      });
    });
  }

  function updateDeleteButton() {
    const btn = document.getElementById('btn-delete-site');
    btn.disabled = !currentSiteId;
    updateExportButton();

    const btnShare = document.getElementById('btn-share-site');
    if (btnShare) btnShare.disabled = !currentSiteId;
  }

  function showFormSection(visible) {
    const form = document.getElementById('lldp-form');
    if (form) {
      form.style.display = visible ? 'flex' : 'none';
    }
  }

  function showStatus(msg, isError) {
    const el = document.getElementById('status-msg');
    el.textContent = msg;
    el.className = 'status-msg ' + (isError ? 'error' : 'success');
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  function loadSiteView() {
    const site = getSite(currentSiteId);
    const traversePanel = document.getElementById('traverse-panel');
    const devicesSection = document.getElementById('devices-section');

    if (!site) {
      showFormSection(false);
      traversePanel.style.display = 'none';
      devicesSection.style.display = '';
      showViewToolbar(false);
      if (network) { network.destroy(); network = null; }
      document.getElementById('device-list').innerHTML = '<div class="empty-state">No site selected</div>';
      hideDeviceDetails();
      showEmptyGraph();
      if (traverseState) traverseState = null;
      return;
    }

    if (!traverseState) {
      const saved = loadTraverseState(site);
      if (saved) {
        traverseState = saved;
      }
    }

    if (traverseState) {
      showFormSection(false);
      traversePanel.style.display = 'flex';
      devicesSection.style.display = 'none';
      updateTraverseUI();
    } else {
      showFormSection(true);
      traversePanel.style.display = 'none';
      devicesSection.style.display = '';
    }

    const hasDevices = Object.keys(site.devices).length > 0;
    showViewToolbar(hasDevices);
    populateRootSelect(site);
    syncRootSelect();

    const isGraphMode = viewMode === 'network' || viewMode === 'tree' || viewMode === 'radial';
    const edgeLabelToggle = document.getElementById('edge-label-toggle');
    if (edgeLabelToggle) edgeLabelToggle.style.display = (hasDevices && isGraphMode) ? 'flex' : 'none';

    if (hasDevices) {
      showViewContainer(getContainerForMode(viewMode));
    } else {
      showViewContainer('network-graph');
    }

    refreshDeviceList();
    if (hasDevices) {
      renderCurrentView(site);
    } else {
      showEmptyGraph();
    }
    hideDeviceDetails();
  }

  function showEmptyGraph() {
    if (network) { network.destroy(); network = null; }
    showViewContainer('network-graph');
    const container = document.getElementById('network-graph');
    container.innerHTML = '<div class="empty-graph">Paste LLDP data to build the topology</div>';
  }

  function init() {
    currentSiteId = localStorage.getItem(SITE_ID_KEY) || null;
    refreshSiteSelector();

    // Site selector
    document.getElementById('site-select').addEventListener('change', (e) => {
      currentSiteId = e.target.value || null;
      if (currentSiteId) {
        localStorage.setItem(SITE_ID_KEY, currentSiteId);
        const site = getSite(currentSiteId);
        if (site && site._sharedUuid) {
          sharedSiteId = site._sharedUuid;
        } else {
          sharedSiteId = null;
          sharedRevision = null;
          sharedRevisions = [];
        }
      } else {
        localStorage.removeItem(SITE_ID_KEY);
        sharedSiteId = null;
        sharedRevision = null;
        sharedRevisions = [];
      }
      if (traverseState) traverseState = null;
      loadSiteView();
      updateDeleteButton();
      updateShareUI();
    });

    // Create site
    document.getElementById('btn-create-site').addEventListener('click', () => {
      const input = document.getElementById('new-site-name');
      const name = input.value.trim();
      if (!name) return;
      const id = createSite(name);
      input.value = '';
      currentSiteId = id;
      localStorage.setItem(SITE_ID_KEY, id);
      refreshSiteSelector();
      loadSiteView();
    });

    // Enter key on site name input
    document.getElementById('new-site-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-create-site').click();
    });

    // Delete site
    document.getElementById('btn-delete-site').addEventListener('click', () => {
      if (!currentSiteId) return;
      const site = getSite(currentSiteId);
      if (!confirm(`Delete site "${site.name}" and all its data?`)) return;
      deleteSite(currentSiteId);
      currentSiteId = null;
      localStorage.removeItem(SITE_ID_KEY);
      refreshSiteSelector();
      loadSiteView();
    });

    // LLDP paste - auto-detect source identity
    document.getElementById('lldp-input').addEventListener('input', (e) => {
      const sourceInput = document.getElementById('source-identity');
      if (!sourceInput.value.trim()) {
        const detected = LLDPParser.detectSourceIdentity(e.target.value);
        if (detected) {
          sourceInput.value = detected;
          sourceInput.dataset.autoDetected = 'true';
        }
      }
    });

    document.getElementById('source-identity').addEventListener('input', (e) => {
      e.target.dataset.autoDetected = '';
    });

    // Submit LLDP data
    document.getElementById('btn-add-lldp').addEventListener('click', () => {
      if (!currentSiteId) return;

      const rawInput = document.getElementById('lldp-input').value.trim();
      const sourceIdentity = document.getElementById('source-identity').value.trim();
      const sourceBoard = document.getElementById('source-board').value.trim();
      const sourceMac = document.getElementById('source-mac').value.trim();

      if (!rawInput) {
        showStatus('Paste LLDP output first', true);
        return;
      }
      if (!sourceIdentity) {
        showStatus('Enter the source device identity', true);
        return;
      }

      const result = LLDPParser.parse(rawInput);
      if (result.neighbors.length === 0) {
        showStatus('No LLDP neighbors found in the output', true);
        return;
      }

      mergeTopology(currentSiteId, sourceIdentity, sourceBoard, sourceMac, result.neighbors);
      showStatus(`Added ${result.neighbors.length} neighbor(s) from ${sourceIdentity}`, false);

      document.getElementById('lldp-input').value = '';
      document.getElementById('source-identity').value = '';
      document.getElementById('source-identity').dataset.autoDetected = '';
      document.getElementById('source-board').value = '';
      document.getElementById('source-mac').value = '';

      loadSiteView();
    });

    // Clear site topology
    document.getElementById('btn-clear-topology').addEventListener('click', () => {
      if (!currentSiteId) return;
      const site = getSite(currentSiteId);
      if (!confirm(`Clear all topology data for "${site.name}"?`)) return;
      site.devices = {};
      site.connections = [];
      updateSite(site);
      loadSiteView();
    });

    // Traverse mode
    document.getElementById('btn-traverse').addEventListener('click', startTraverse);

    document.getElementById('btn-end-traverse').addEventListener('click', () => {
      if (traverseState && traverseState.visited.size > 0) {
        if (!confirm('End traverse? Topology data will be kept.')) return;
      }
      endTraverse();
    });

    document.getElementById('traverse-lldp').addEventListener('input', (e) => {
      const detected = LLDPParser.detectSourceIdentity(e.target.value);
      if (detected) {
        document.getElementById('traverse-identity').value = detected;
      }
    });

    document.getElementById('btn-traverse-submit').addEventListener('click', submitTraverseLLDP);

    document.getElementById('traverse-lldp').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        submitTraverseLLDP();
      }
    });

    // Combined command builder
    function updateTraverseCommand() {
      const parts = ['/ip/neighbor/print detail where discovered-by~"lldp"'];
      if (document.getElementById('chk-collect-iface').checked) parts.push('/interface/print without-paging');
      if (document.getElementById('chk-collect-ip').checked) parts.push('/ip/address/print without-paging');
      if (document.getElementById('chk-collect-vlan').checked) parts.push('/interface/bridge/vlan/print without-paging');
      document.getElementById('traverse-combined-cmd').textContent = parts.join('; ');
    }

    document.getElementById('chk-collect-iface').addEventListener('change', updateTraverseCommand);
    document.getElementById('chk-collect-ip').addEventListener('change', updateTraverseCommand);
    document.getElementById('chk-collect-vlan').addEventListener('change', updateTraverseCommand);

    document.getElementById('btn-copy-traverse-cmd').addEventListener('click', function() {
      const cmd = document.getElementById('traverse-combined-cmd').textContent;
      navigator.clipboard.writeText(cmd).then(() => {
        this.classList.add('copied');
        setTimeout(() => this.classList.remove('copied'), 1500);
      });
    });

    // View mode toolbar
    document.querySelectorAll('.view-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
    });

    document.getElementById('root-node-select').addEventListener('change', (e) => {
      setRootNode(e.target.value || null);
    });

    document.getElementById('btn-copy-text').addEventListener('click', function() {
      const output = document.getElementById('text-tree-output');
      navigator.clipboard.writeText(output.textContent).then(() => {
        this.classList.add('copied');
        const label = this.querySelector('span');
        label.textContent = 'Copied!';
        setTimeout(() => { this.classList.remove('copied'); label.textContent = 'Copy'; }, 1500);
      });
    });

    // Search
    document.getElementById('search-input').addEventListener('input', () => applySearchFilter());

    // Edge labels toggle
    document.getElementById('chk-edge-labels').addEventListener('change', (e) => {
      toggleEdgeLabels(e.target.checked);
    });

    // CSV export
    document.getElementById('btn-csv-export').addEventListener('click', () => {
      const site = getSite(currentSiteId);
      if (site) exportCSV(site);
    });


    // Help modal
    document.getElementById('btn-help').addEventListener('click', openHelp);
    document.getElementById('btn-close-help').addEventListener('click', closeHelp);
    document.getElementById('help-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeHelp();
    });
    document.getElementById('btn-download-manifest').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = 'lldpviz-format.manifest.json';
      a.download = 'lldpviz-format.manifest.json';
      a.click();
    });

    // About modal
    document.getElementById('btn-about').addEventListener('click', openAbout);
    document.getElementById('btn-close-about').addEventListener('click', closeAbout);
    document.getElementById('about-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeAbout();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeHelp(); closeAbout(); }
    });

    // JSON Export / Import
    document.getElementById('btn-export-site').addEventListener('click', exportSite);
    document.getElementById('btn-import-site').addEventListener('click', () => {
      document.getElementById('import-file-input').click();
    });
    document.getElementById('import-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importSite(file);
      e.target.value = '';
    });

    // Share / Save
    document.getElementById('btn-share-site').addEventListener('click', shareSite);
    document.getElementById('btn-save-revision').addEventListener('click', saveRevision);
    document.getElementById('btn-copy-share-link').addEventListener('click', function() {
      if (!sharedSiteId) return;
      const url = `${location.origin}/?share=${sharedSiteId}`;
      navigator.clipboard.writeText(url).then(() => {
        this.textContent = 'Copied!';
        setTimeout(() => { this.textContent = 'Link'; }, 1500);
      });
    });
    document.getElementById('revision-select').addEventListener('change', (e) => {
      const rev = parseInt(e.target.value);
      if (rev && rev !== sharedRevision) switchRevision(rev);
    });

    // Restore share state if current site has a linked UUID
    if (currentSiteId) {
      const site = getSite(currentSiteId);
      if (site && site._sharedUuid) {
        sharedSiteId = site._sharedUuid;
      }
    }

    // Initial view + check for shared link
    loadSiteView();
    updateShareUI();
    checkUrlForShare();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
