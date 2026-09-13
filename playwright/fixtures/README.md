# Media proof fixtures

These files contain synthetic content only. The two SVGs are simple geometric artwork for a video poster and a link thumbnail; they contain no captured application or personal data. The browser test rasterizes them to PNG with the existing Sharp dependency.

The test generates its own silent WebM clip with Canvas and MediaRecorder. No binary video, external download, or extra encoder dependency is needed. MP4 and HLS variant selection are covered by the component tests.

Playback tests serve these files locally and verify that the video clock advances. They do not contact X or an external preview service.
