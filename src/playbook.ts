// Guidance handed to the calling model through vids_status, so it plans scenes that Google Vids can actually run.
export const PLAYBOOK = {
  workflow: [
    "Call vids_status first. If it returns a hint, relay it to the user and stop.",
    "Plan the whole piece as scenes of one shot each, then send them in ONE vids_generate call so file numbering and chaining work. One project = one Vids video; each clip gets its own scene in it.",
    "Every video clip uses the account's Vids generation quota and Vids shows no price: tell the user how many clips will be made and get their OK before queueing video.",
    "Call vids_wait repeatedly until finished is true; scenes run one at a time with 25-70 s pauses, and a clip takes about a minute.",
    "To put the spoken words on screen: FIRST call vids_transcribe on the film (with `language`), show the user the words, flag anything that looks misheard (names especially), propose the fixes, and wait for the user to confirm or correct them. Only then call vids_captions once, passing the agreed words as `text`.",
    "If an image batch finishes with \"still failed: scene ...\" in its note, call vids_retry with its job id: only those stills are made again.",
    "No call blocks for more than about 45 s. A reply with still_working and a task_id means Vids is still busy with it: pass the task_id to vids_wait, and never repeat the call.",
  ],
  model: "Omni is the only video model in Vids: 3-10 s per clip, 720p or 1080p, 16:9 or 9:16. Stills come from Gerar uma imagem (16:9, 9:16 or 1:1, seven styles), which takes no reference picture.",
  prompt_order: "subject and action -> shot size and camera move -> location -> visual style -> lighting -> sound/dialogue",
  prompt_rules: [
    "One continuous shot per scene, one camera move per scene. Portuguese or English both work.",
    "Name the camera behaviour explicitly (static locked-off, slow push-in, orbit, crane up, handheld).",
    "Repeat the full description of a recurring character or product in every scene; Vids has no memory between clips.",
    "Put spoken lines in quotes and say who speaks; keep a line short enough for the clip length.",
    "Give a shot ONE specific action with a beginning and an end; a continuous activity in close-up loops aimlessly.",
  ],
  continuity: [
    "chain_previous: true carries the previous scene's clip on with Vids' Estender tab, for one continuous take across clips.",
    "first_frame animates from a picture (Animar): make the still first with type 'image', then use its file.",
    "reference_images (max 3, Vids' Ingredientes) keep a person or product consistent; 'asset:<name>' uses a character from vids_character.",
    "avatar puts one of Vids' stock avatars (vids_status lists them) in the clip.",
  ],
};
