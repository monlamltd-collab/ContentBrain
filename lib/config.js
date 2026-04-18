require('dotenv').config();

const brands = {
  auctionbrain: {
    name: 'AuctionBrain',
    url: 'auctionbrain.co.uk',
    audience: 'UK property investors looking for auction deals',
    tone: 'sharp, data-driven, insider advantage',
    messages: [
      '168 auction houses searched in one place',
      '~50% of auction lots never reach Rightmove',
      'AI investment scoring on every lot',
      'Completely free to use',
      'Bridging finance matching built in'
    ],
    colours: {
      navy: '#1a2b4b',
      green: '#0f8a5f',
      cream: '#faf8f4',
      red: '#C0392B'
    },
    fonts: {
      heading: "'IBM Plex Sans', Arial, sans-serif",
      headingMono: "'IBM Plex Mono', 'Courier New', monospace",
      body: "'IBM Plex Sans', Arial, sans-serif"
    },
    logoPath: '/templates/logos/auctionbrain.png'
  },
  bridgematch: {
    name: 'BridgeMatch',
    url: 'bridgematch.co.uk',
    audience: 'Property investors and developers needing bridging finance',
    tone: 'professional, reassuring, makes complex simple',
    messages: [
      'Match to the right bridging lender in minutes',
      'Know your deal is fundable before you bid',
      'Per-lender LTGDV calculations',
      'Completely free to use'
    ],
    colours: {
      navy: '#1a2b4b',
      green: '#0f8a5f',
      cream: '#faf8f4',
      red: '#C0392B'
    },
    fonts: {
      heading: "'IBM Plex Sans', Arial, sans-serif",
      headingMono: "'IBM Plex Mono', 'Courier New', monospace",
      body: "'IBM Plex Sans', Arial, sans-serif"
    },
    logoPath: '/templates/logos/bridgematch.png'
  }
};

const platforms = {
  facebook: { width: 1080, height: 1080 },
  linkedin: { width: 1080, height: 1080 },
  tiktok: { width: 1080, height: 1920 }
};

const templateTypes = ['stat', 'hook', 'list', 'reel'];

// Reel template always uses 9:16 regardless of platform
function getDimensions(templateType, platform) {
  if (templateType === 'reel') return { width: 1080, height: 1920 };
  return platforms[platform] || { width: 1080, height: 1080 };
}

module.exports = { brands, platforms, templateTypes, getDimensions };
