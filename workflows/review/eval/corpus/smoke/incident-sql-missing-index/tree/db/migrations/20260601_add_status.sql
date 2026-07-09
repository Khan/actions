-- Add a fulfillment status to orders so the picker UI can filter work.
ALTER TABLE orders
    ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
