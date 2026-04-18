const React = require('react');
const { useCurrentFrame, useVideoConfig, interpolate } = require('remotion');

// Seeded random for deterministic node placement
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
}

// Generate fixed node positions (right side of frame)
function generateNodes(count, width, height, seed) {
  const rng = seededRandom(seed);
  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push({
      x: width * 0.5 + rng() * width * 0.5, // right half
      y: rng() * height,
      radius: 2 + rng() * 3,
      isRed: rng() > 0.7, // ~30% are red accent dots
      speed: 0.3 + rng() * 0.7,
      phase: rng() * Math.PI * 2,
    });
  }
  return nodes;
}

// Find edges between nearby nodes
function generateEdges(nodes, maxDist) {
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < maxDist) {
        edges.push({ from: i, to: j, dist });
      }
    }
  }
  return edges;
}

const NetworkBackground = ({ nodeCount = 25, seed = 42 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const time = frame / fps;

  const nodes = React.useMemo(() => generateNodes(nodeCount, width, height, seed), [nodeCount, width, height, seed]);
  const edges = React.useMemo(() => generateEdges(nodes, 200), [nodes]);

  // Animate node positions with subtle drift
  const animatedNodes = nodes.map((n, i) => ({
    ...n,
    x: n.x + Math.sin(time * n.speed + n.phase) * 8,
    y: n.y + Math.cos(time * n.speed * 0.7 + n.phase) * 6,
  }));

  // Fade in the network
  const networkOpacity = interpolate(frame, [0, 30], [0, 0.6], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const svgChildren = [];

  // Edges
  edges.forEach((edge, i) => {
    const fromNode = animatedNodes[edge.from];
    const toNode = animatedNodes[edge.to];
    const edgeOpacity = Math.max(0, 1 - edge.dist / 200) * 0.4;
    svgChildren.push(
      React.createElement('line', {
        key: 'e' + i,
        x1: fromNode.x,
        y1: fromNode.y,
        x2: toNode.x,
        y2: toNode.y,
        stroke: fromNode.isRed || toNode.isRed ? '#C0392B' : '#444466',
        strokeWidth: 0.8,
        opacity: edgeOpacity,
      })
    );
  });

  // Nodes
  animatedNodes.forEach((n, i) => {
    const pulse = 1 + Math.sin(time * 2 + n.phase) * 0.3;
    svgChildren.push(
      React.createElement('circle', {
        key: 'n' + i,
        cx: n.x,
        cy: n.y,
        r: n.radius * pulse,
        fill: n.isRed ? '#C0392B' : '#666688',
        opacity: n.isRed ? 0.9 : 0.5,
      })
    );
  });

  // Red grid lines (subtle, like the Canva style)
  for (let i = 0; i < 3; i++) {
    const lineX = width * 0.6 + i * 80;
    const lineY = height * 0.3 + i * 60;
    svgChildren.push(
      React.createElement('line', {
        key: 'gv' + i,
        x1: lineX, y1: 0, x2: lineX, y2: height,
        stroke: '#C0392B',
        strokeWidth: 0.5,
        opacity: 0.15,
      }),
      React.createElement('line', {
        key: 'gh' + i,
        x1: width * 0.4, y1: lineY, x2: width, y2: lineY,
        stroke: '#C0392B',
        strokeWidth: 0.5,
        opacity: 0.15,
      })
    );
  }

  return React.createElement('div', {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      opacity: networkOpacity,
    },
  },
    React.createElement('svg', {
      width: width,
      height: height,
      viewBox: `0 0 ${width} ${height}`,
    }, ...svgChildren)
  );
};

module.exports = { NetworkBackground };
