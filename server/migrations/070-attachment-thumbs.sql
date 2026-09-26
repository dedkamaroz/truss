-- Small preview images for attachments (JPEG, at most 128 KB), made by the browser the first time a file
-- is shown and stored here, so tables show thumbnails without every browser downloading and decoding the
-- full-size originals. Removed with their attachment.
CREATE TABLE attachment_thumbs (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments (id) ON DELETE CASCADE,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
