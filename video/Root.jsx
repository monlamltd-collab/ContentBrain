const React = require('react');
const { Composition } = require('remotion');
const { StatVideo } = require('./compositions/StatVideo');
const { HookVideo } = require('./compositions/HookVideo');
const { ListVideo } = require('./compositions/ListVideo');
const { ReelVideo } = require('./compositions/ReelVideo');
const { LotVideo } = require('./compositions/LotVideo');

const FPS = 30;

const defaultBrand = {
  colours: { navy: '#0d0d14', green: '#0f8a5f', cream: '#faf8f4', red: '#C0392B' },
  fonts: { heading: "'IBM Plex Sans', Arial, sans-serif", body: "'IBM Plex Sans', Arial, sans-serif" },
};

const Root = () => {
  return React.createElement(React.Fragment, null,
    React.createElement(Composition, {
      id: 'StatVideo',
      component: StatVideo,
      durationInFrames: 6 * FPS,
      fps: FPS,
      width: 1080,
      height: 1080,
      defaultProps: {
        headline: '168 Auction Houses',
        body: 'Search every UK property auction in one place',
        brand: defaultBrand,
        brandKey: 'auctionbrain',
        musicFile: null,
        voiceoverFile: null,
      },
    }),
    React.createElement(Composition, {
      id: 'HookVideo',
      component: HookVideo,
      durationInFrames: 7 * FPS,
      fps: FPS,
      width: 1080,
      height: 1080,
      defaultProps: {
        headline: "The deals Rightmove doesn't show you",
        body: 'Nearly half of all auction lots never appear on the major portals. AuctionBrain searches them all.',
        cta: 'Try AuctionBrain free',
        brand: defaultBrand,
        brandKey: 'auctionbrain',
        musicFile: null,
        voiceoverFile: null,
      },
    }),
    React.createElement(Composition, {
      id: 'ListVideo',
      component: ListVideo,
      durationInFrames: 8 * FPS,
      fps: FPS,
      width: 1080,
      height: 1080,
      defaultProps: {
        headline: 'Why auction investors use AuctionBrain',
        items: [
          'Search 168 auction houses in one place',
          'Find lots that never reach Rightmove',
          'AI scores every investment opportunity',
          'Bridging finance matching built in',
        ],
        brand: defaultBrand,
        brandKey: 'auctionbrain',
        musicFile: null,
        voiceoverFile: null,
      },
    }),
    React.createElement(Composition, {
      id: 'ReelVideo',
      component: ReelVideo,
      durationInFrames: 6 * FPS,
      fps: FPS,
      width: 1080,
      height: 1920,
      defaultProps: {
        headline: 'Hidden Auction Deals',
        body: "The lots your competitors can't find",
        brand: defaultBrand,
        brandKey: 'auctionbrain',
        musicFile: null,
        voiceoverFile: null,
      },
    }),
    React.createElement(Composition, {
      id: 'LotVideo',
      component: LotVideo,
      durationInFrames: 75 * FPS,
      fps: FPS,
      width: 1080,
      height: 1920,
      defaultProps: {
        lot: {
          address: 'Silver Street, Nailsea',
          postcode: 'BS48 2DS',
          price: 100000,
          beds: 3,
          prop_type: 'flat',
          image_url: 'https://www.hollismorgan.co.uk/resize/34541795/0/480.pagespeed.ce.cf6fnWxZMX.jpg',
        },
        archetype: 'deepest-discount',
        hookHeadline: '81% below street value',
        keyBullets: [
          'Guide £100k vs £523k street comps',
          '13.5% gross yield potential',
          '3-bed leasehold, refurb required',
          'Auction 20 May'
        ],
        brand: defaultBrand,
        brandKey: 'auctionbrain',
        musicFile: null,
        voiceoverFile: null,
      },
    })
  );
};

module.exports = { Root };
