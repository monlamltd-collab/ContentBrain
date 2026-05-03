# Graph Report - C:\Users\User\Documents\GitHub\ContentBrain  (2026-04-17)

## Corpus Check
- 20 files · ~467,576 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 76 nodes · 109 edges · 17 communities detected
- Extraction: 69% EXTRACTED · 31% INFERRED · 0% AMBIGUOUS · INFERRED: 34 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]

## God Nodes (most connected - your core abstractions)
1. `pollTelegram()` - 17 edges
2. `generateBatch()` - 9 edges
3. `runGenerate()` - 7 edges
4. `renderVideo()` - 7 edges
5. `run()` - 7 edges
6. `renderPost()` - 6 edges
7. `publishToMake()` - 4 edges
8. `publish()` - 4 edges
9. `buildHtml()` - 4 edges
10. `insertPost()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `runGenerate()` --calls--> `generateBatch()`  [INFERRED]
  C:\Users\User\Documents\GitHub\ContentBrain\server.js → C:\Users\User\Documents\GitHub\ContentBrain\lib\generate.js
- `runGenerate()` --calls--> `renderPost()`  [INFERRED]
  C:\Users\User\Documents\GitHub\ContentBrain\server.js → C:\Users\User\Documents\GitHub\ContentBrain\lib\renderer.js
- `runGenerate()` --calls--> `renderVideo()`  [INFERRED]
  C:\Users\User\Documents\GitHub\ContentBrain\server.js → C:\Users\User\Documents\GitHub\ContentBrain\lib\video-renderer.js
- `pollTelegram()` --calls--> `removeButtons()`  [INFERRED]
  C:\Users\User\Documents\GitHub\ContentBrain\server.js → C:\Users\User\Documents\GitHub\ContentBrain\lib\telegram.js
- `pollTelegram()` --calls--> `answerCallback()`  [INFERRED]
  C:\Users\User\Documents\GitHub\ContentBrain\server.js → C:\Users\User\Documents\GitHub\ContentBrain\lib\telegram.js

## Communities

### Community 0 - "Community 0"
Cohesion: 0.2
Nodes (15): run(), pollTelegram(), runGenerate(), getApprovedPosts(), getDraftPosts(), getPendingBriefs(), getPostById(), insertPost() (+7 more)

### Community 1 - "Community 1"
Cohesion: 0.48
Nodes (6): assignPlatforms(), generateBatch(), generateCopy(), getSystemPrompt(), pickTemplates(), markBriefsUsed()

### Community 2 - "Community 2"
Cohesion: 0.43
Nodes (5): getDimensions(), buildHtml(), escapeHtml(), renderPost(), renderTestSuite()

### Community 3 - "Community 3"
Cohesion: 0.6
Nodes (5): buildProps(), ensureBundle(), pickMusicFile(), renderVideo(), renderVideoTestSuite()

### Community 4 - "Community 4"
Cohesion: 0.5
Nodes (2): loginPage(), requireAuth()

### Community 5 - "Community 5"
Cohesion: 0.6
Nodes (4): publish(), publishToFacebook(), publishToMake(), uploadMedia()

### Community 6 - "Community 6"
Cohesion: 0.5
Nodes (2): generateNodes(), seededRandom()

### Community 7 - "Community 7"
Cohesion: 0.83
Nodes (3): findFfmpeg(), processAllVoiceovers(), processVoiceover()

### Community 8 - "Community 8"
Cohesion: 1.0
Nodes (2): ScrambleText(), seededRandom()

### Community 9 - "Community 9"
Cohesion: 1.0
Nodes (2): getNextScheduleSlot(), run()

### Community 10 - "Community 10"
Cohesion: 1.0
Nodes (0): 

### Community 11 - "Community 11"
Cohesion: 1.0
Nodes (0): 

### Community 12 - "Community 12"
Cohesion: 1.0
Nodes (0): 

### Community 13 - "Community 13"
Cohesion: 1.0
Nodes (0): 

### Community 14 - "Community 14"
Cohesion: 1.0
Nodes (0): 

### Community 15 - "Community 15"
Cohesion: 1.0
Nodes (0): 

### Community 16 - "Community 16"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **Thin community `Community 10`** (2 nodes): `Root.jsx`, `Root()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 11`** (2 nodes): `BrandLogo()`, `BrandLogo.jsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 12`** (2 nodes): `HookVideo.jsx`, `HookVideo()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 13`** (2 nodes): `ListVideo.jsx`, `ListVideo()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 14`** (2 nodes): `ReelVideo.jsx`, `ReelVideo()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 15`** (2 nodes): `StatVideo.jsx`, `StatVideo()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 16`** (1 nodes): `index.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `pollTelegram()` connect `Community 0` to `Community 1`, `Community 2`, `Community 3`, `Community 4`, `Community 5`?**
  _High betweenness centrality (0.259) - this node is a cross-community bridge._
- **Why does `renderPost()` connect `Community 2` to `Community 0`, `Community 9`?**
  _High betweenness centrality (0.101) - this node is a cross-community bridge._
- **Why does `generateBatch()` connect `Community 1` to `Community 0`, `Community 9`?**
  _High betweenness centrality (0.100) - this node is a cross-community bridge._
- **Are the 16 inferred relationships involving `pollTelegram()` (e.g. with `updatePostStatus()` and `removeButtons()`) actually correct?**
  _`pollTelegram()` has 16 INFERRED edges - model-reasoned connections that need verification._
- **Are the 5 inferred relationships involving `generateBatch()` (e.g. with `runGenerate()` and `pollTelegram()`) actually correct?**
  _`generateBatch()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **Are the 6 inferred relationships involving `runGenerate()` (e.g. with `generateBatch()` and `renderPost()`) actually correct?**
  _`runGenerate()` has 6 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `renderVideo()` (e.g. with `runGenerate()` and `pollTelegram()`) actually correct?**
  _`renderVideo()` has 3 INFERRED edges - model-reasoned connections that need verification._