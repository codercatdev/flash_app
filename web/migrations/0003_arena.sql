-- Model arena: one prompt fans out to two models, the user picks a winner blind.
--
-- Additive only. This runs against a live D1 holding real token balances, so there
-- are no DROPs and no table rewrites.

ALTER TABLE generation ADD COLUMN model TEXT;
ALTER TABLE generation ADD COLUMN battleId TEXT;

-- Everything that exists today came from the Turbo endpoint; it is the only model
-- that has ever run.
UPDATE generation SET model = 'sdxl-turbo' WHERE model IS NULL;

CREATE TABLE IF NOT EXISTS battle (
  id          TEXT    PRIMARY KEY,
  userId      TEXT    NOT NULL,
  prompt      TEXT    NOT NULL,
  status      TEXT    NOT NULL,  -- PENDING | READY | VOTED | FAILED
  -- Display order, randomized at creation. This IS the blind: the API refuses to
  -- reveal which model is on which side until a vote is recorded.
  leftModel   TEXT    NOT NULL,
  rightModel  TEXT    NOT NULL,
  winnerModel TEXT,
  createdAt   INTEGER NOT NULL,
  votedAt     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_battle_user ON battle (userId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_battle_voted ON battle (votedAt DESC);
CREATE INDEX IF NOT EXISTS idx_generation_battle ON generation (battleId);
