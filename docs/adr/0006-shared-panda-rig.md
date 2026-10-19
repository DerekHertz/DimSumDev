# Bao and every cell share one hand-placed panda rig

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

The plush panda is animated with one small hand-placed skeleton (about ten bones: root, belly, head, ears, arms, legs, plus paw and hat sockets) shared by Bao and every cell, driven by one clip library. Faces change through a texture-swap atlas, not facial geometry. The web build uses baked fur and a rim-light shader instead of fur shells. We rejected auto-rigging (the chubby proportions rig badly), shape-key-only motion (props can't follow paws), and a separate richer Bao rig (it would double the clip work). Every clip, prop socket and face frame depends on this rig, so changing it later means re-authoring the library.
