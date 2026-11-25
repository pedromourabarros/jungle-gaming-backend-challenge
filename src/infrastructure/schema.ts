/** Versioned SQL owned by MikroORM migrations. Never use schema:update in production. */
export const schemaUp = String.raw`
CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL,
  currency text NOT NULL CHECK (currency IN ('BRL','USD','EUR','GBP')),
  balance numeric(28,2) NOT NULL CHECK (balance >= 0 AND balance <> 'NaN'::numeric),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (player_id, currency)
);

CREATE TABLE wager_transactions (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 100),
  external_transaction_id text NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  player_id uuid NOT NULL,
  round_id text NOT NULL,
  game_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount numeric(28,2) NOT NULL CHECK (amount >= 0 AND amount <> 'NaN'::numeric),
  currency text NOT NULL CHECK (currency IN ('BRL','USD','EUR','GBP')),
  reference_external_transaction_id text,
  reference_transaction_id uuid REFERENCES wager_transactions(id),
  status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code text,
  observed_balance numeric(28,2) CHECK (observed_balance >= 0 AND observed_balance <> 'NaN'::numeric),
  observed_currency text CHECK (observed_currency IN ('BRL','USD','EUR','GBP')),
  created_at timestamptz NOT NULL,
  processed_at timestamptz,
  correlation_id text NOT NULL,
  causation_id text,
  pending_attempts integer NOT NULL DEFAULT 0 CHECK (pending_attempts >= 0),
  next_attempt_at timestamptz,
  UNIQUE (provider_id, external_transaction_id),
  CHECK ((kind = 'LOSS' AND amount >= 0) OR (kind <> 'LOSS' AND amount > 0)),
  CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
  CHECK (reference_external_transaction_id IS DISTINCT FROM external_transaction_id),
  CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
  CHECK (status IN ('REJECTED','FAILED') OR failure_code IS NULL),
  CHECK (status NOT IN ('PROCESSED','REJECTED','FAILED') OR
         (processed_at IS NOT NULL AND observed_balance IS NOT NULL AND observed_currency IS NOT NULL)),
  CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL)
  ,CHECK (status <> 'PROCESSED' OR (reference_external_transaction_id IS NULL) = (reference_transaction_id IS NULL))
  ,CHECK (kind <> 'OPENING' OR (provider_id = '__system__' AND round_id = '__opening__' AND game_id = '__opening__'))
  ,CHECK (status <> 'PENDING_REFERENCE' OR (reference_external_transaction_id IS NOT NULL
    AND observed_balance IS NOT NULL AND observed_currency IS NOT NULL AND next_attempt_at IS NOT NULL))
  ,CHECK (status NOT IN ('PROCESSED','REJECTED','FAILED') OR next_attempt_at IS NULL)
);
CREATE UNIQUE INDEX one_opening_per_wallet ON wager_transactions(wallet_id) WHERE kind = 'OPENING';
CREATE UNIQUE INDEX one_processed_reversal_per_kind
  ON wager_transactions(reference_transaction_id, kind)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE INDEX pending_references_due ON wager_transactions(next_attempt_at, id)
  WHERE status = 'PENDING_REFERENCE';
CREATE INDEX transactions_wallet ON wager_transactions(wallet_id, created_at, id);

CREATE TABLE wallet_ledger_entries (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
  wallet_version integer NOT NULL CHECK (wallet_version >= 1),
  direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount numeric(28,2) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric),
  currency text NOT NULL CHECK (currency IN ('BRL','USD','EUR','GBP')),
  balance_before numeric(28,2) NOT NULL CHECK (balance_before >= 0 AND balance_before <> 'NaN'::numeric),
  balance_after numeric(28,2) NOT NULL CHECK (balance_after >= 0 AND balance_after <> 'NaN'::numeric),
  created_at timestamptz NOT NULL,
  UNIQUE (wallet_id, transaction_id),
  UNIQUE (wallet_id, wallet_version),
  CHECK ((direction = 'CREDIT' AND balance_after = balance_before + amount)
      OR (direction = 'DEBIT' AND balance_after = balance_before - amount))
);

CREATE TABLE inbox_messages (
  consumer_name text NOT NULL,
  message_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  transaction_id uuid REFERENCES wager_transactions(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (consumer_name, message_id),
  CHECK (processed_at IS NULL OR transaction_id IS NOT NULL)
);

CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
  aggregate_id uuid NOT NULL REFERENCES wallets(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  lease_owner uuid,
  lease_until timestamptz,
  UNIQUE (transaction_id, event_type),
  CHECK ((payload->>'eventId') IS NOT DISTINCT FROM id::text),
  CHECK ((payload->>'aggregateId') IS NOT DISTINCT FROM aggregate_id::text),
  CHECK ((payload->>'eventType') IS NOT DISTINCT FROM event_type),
  CHECK ((payload->'data'->>'transactionId') IS NOT DISTINCT FROM transaction_id::text),
  CHECK ((payload->>'version') IS NOT DISTINCT FROM '1'),
  CHECK (jsonb_typeof(payload->'correlationId') = 'string' AND payload ? 'correlationId'),
  CHECK (jsonb_typeof(payload->'occurredAt') = 'string' AND payload ? 'occurredAt')
);
CREATE INDEX outbox_due ON outbox_messages(next_attempt_at, occurred_at, id)
  WHERE published_at IS NULL;

CREATE TABLE failed_messages (
  consumer_name text NOT NULL,
  message_id text NOT NULL,
  payload_hash text NOT NULL,
  failure_code text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, message_id)
);

CREATE FUNCTION forbid_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable audit history' USING ERRCODE = '23514';
END; $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER transactions_no_delete BEFORE DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON wager_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER wallets_no_delete BEFORE DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER wallets_no_truncate BEFORE TRUNCATE ON wallets
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();

CREATE FUNCTION guard_wallet_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable wallet identity' USING ERRCODE = '23514';
  END IF;
  IF (NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1)
     OR (NEW.balance = OLD.balance AND NEW.version <> OLD.version) THEN
    RAISE EXCEPTION 'wallet version must follow balance changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER wallet_update BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION guard_wallet_update();

CREATE FUNCTION verify_wallet_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e wallet_ledger_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'wallet must open at version 1' USING ERRCODE = '23514';
    END IF;
    IF NEW.balance = 0 THEN RETURN NULL; END IF;
    SELECT * INTO e FROM wallet_ledger_entries WHERE wallet_id = NEW.id AND wallet_version = 1;
    IF NOT FOUND OR e.balance_before <> 0 OR e.balance_after <> NEW.balance OR e.direction <> 'CREDIT'
       OR NOT EXISTS (SELECT 1 FROM wager_transactions WHERE id = e.transaction_id AND kind = 'OPENING') THEN
      RAISE EXCEPTION 'positive opening requires matching ledger' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.balance <> OLD.balance THEN
    SELECT * INTO e FROM wallet_ledger_entries WHERE wallet_id = NEW.id AND wallet_version = NEW.version;
    IF NOT FOUND OR e.balance_before <> OLD.balance OR e.balance_after <> NEW.balance THEN
      RAISE EXCEPTION 'wallet change requires matching ledger' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER wallet_movement AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wallet_movement();

CREATE FUNCTION verify_ledger_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w wallets%ROWTYPE; t wager_transactions%ROWTYPE; r wager_transactions%ROWTYPE;
        previous wallet_ledger_entries%ROWTYPE; expected_direction text;
BEGIN
  SELECT * INTO w FROM wallets WHERE id = NEW.wallet_id FOR UPDATE;
  SELECT * INTO t FROM wager_transactions WHERE id = NEW.transaction_id;
  IF t.id IS NULL OR t.status <> 'PROCESSED' OR t.kind = 'LOSS'
     OR t.wallet_id <> w.id OR t.player_id <> w.player_id
     OR t.currency <> w.currency OR NEW.currency <> w.currency OR NEW.amount <> t.amount THEN
    RAISE EXCEPTION 'ledger transaction mismatch' USING ERRCODE = '23514';
  END IF;
  expected_direction := CASE WHEN t.kind = 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
  IF t.kind = 'ROLLBACK' THEN
    SELECT * INTO r FROM wager_transactions WHERE id = t.reference_transaction_id;
    expected_direction := CASE WHEN r.kind = 'BET' THEN 'CREDIT' ELSE 'DEBIT' END;
  END IF;
  IF NEW.direction <> expected_direction OR NEW.wallet_version <> w.version OR NEW.balance_after <> w.balance THEN
    RAISE EXCEPTION 'ledger does not match materialized wallet' USING ERRCODE = '23514';
  END IF;
  IF t.kind = 'OPENING' AND (NEW.wallet_version <> 1 OR NEW.balance_before <> 0) THEN
    RAISE EXCEPTION 'OPENING must be the original balance' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO previous FROM wallet_ledger_entries WHERE wallet_id = w.id ORDER BY wallet_version DESC LIMIT 1;
  IF FOUND THEN
    IF NEW.wallet_version <> previous.wallet_version + 1 OR NEW.balance_before <> previous.balance_after THEN
      RAISE EXCEPTION 'ledger chain discontinuity' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.balance_before <> 0 OR
       NOT ((t.kind = 'OPENING' AND NEW.wallet_version = 1) OR (t.kind <> 'OPENING' AND NEW.wallet_version = 2)) THEN
      RAISE EXCEPTION 'invalid ledger origin' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER ledger_insert BEFORE INSERT ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION verify_ledger_insert();

CREATE FUNCTION guard_transaction_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal transaction is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id,NEW.provider_id,NEW.external_transaction_id,NEW.idempotency_key,NEW.payload_hash,
      NEW.wallet_id,NEW.player_id,NEW.round_id,NEW.game_id,NEW.kind,NEW.amount,NEW.currency,
      NEW.reference_external_transaction_id,NEW.created_at,NEW.correlation_id,NEW.causation_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.provider_id,OLD.external_transaction_id,OLD.idempotency_key,OLD.payload_hash,
      OLD.wallet_id,OLD.player_id,OLD.round_id,OLD.game_id,OLD.kind,OLD.amount,OLD.currency,
      OLD.reference_external_transaction_id,OLD.created_at,OLD.correlation_id,OLD.causation_id) THEN
    RAISE EXCEPTION 'transaction business payload is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
    RAISE EXCEPTION 'invalid state transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER transaction_update BEFORE UPDATE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_transaction_update();

CREATE FUNCTION verify_transaction_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t wager_transactions%ROWTYPE; w wallets%ROWTYPE; r wager_transactions%ROWTYPE;
        n integer; event_name text;
BEGIN
  SELECT * INTO t FROM wager_transactions WHERE id = NEW.id;
  SELECT count(*) INTO n FROM wallet_ledger_entries WHERE transaction_id = t.id;
  IF t.status = 'PROCESSED' THEN
    SELECT * INTO w FROM wallets WHERE id = t.wallet_id;
    IF t.player_id <> w.player_id OR t.currency <> w.currency OR t.observed_currency <> w.currency THEN
      RAISE EXCEPTION 'processed transaction identity mismatch' USING ERRCODE = '23514';
    END IF;
    IF (t.kind = 'LOSS' AND n <> 0) OR (t.kind <> 'LOSS' AND n <> 1) THEN
      RAISE EXCEPTION 'processed transaction requires its ledger' USING ERRCODE = '23514';
    END IF;
    IF t.kind <> 'LOSS' AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries
      WHERE transaction_id = t.id AND balance_after = t.observed_balance) THEN
      RAISE EXCEPTION 'observed balance must match ledger result' USING ERRCODE = '23514';
    END IF;
    IF t.reference_external_transaction_id IS NOT NULL THEN
      SELECT * INTO r FROM wager_transactions WHERE id = t.reference_transaction_id;
      IF r.id IS NULL OR r.status <> 'PROCESSED' OR r.provider_id <> t.provider_id
        OR r.external_transaction_id <> t.reference_external_transaction_id
        OR r.player_id <> t.player_id OR r.wallet_id <> t.wallet_id OR r.currency <> t.currency OR r.round_id <> t.round_id
        OR (t.kind IN ('WIN','LOSS','REFUND') AND r.kind <> 'BET')
        OR (t.kind = 'ROLLBACK' AND r.kind NOT IN ('BET','WIN','REFUND'))
        OR (t.kind IN ('REFUND','ROLLBACK') AND t.amount <> r.amount) THEN
        RAISE EXCEPTION 'invalid processed reference' USING ERRCODE = '23514';
      END IF;
    END IF;
    event_name := 'WagerTransactionProcessed';
  ELSIF t.status IN ('REJECTED','FAILED','PENDING_REFERENCE') THEN
    IF n <> 0 THEN RAISE EXCEPTION 'nonprocessed transaction cannot have ledger' USING ERRCODE = '23514'; END IF;
    event_name := CASE t.status WHEN 'REJECTED' THEN 'WagerTransactionRejected'
      WHEN 'FAILED' THEN 'WagerTransactionFailed' ELSE 'WagerTransactionPendingReference' END;
  ELSE
    IF n <> 0 THEN RAISE EXCEPTION 'pending transaction cannot have ledger' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM outbox_messages WHERE transaction_id = t.id AND event_type = event_name) THEN
    RAISE EXCEPTION 'transaction result requires transactional outbox' USING ERRCODE = '23514';
  END IF;
  IF n = 1 AND NOT EXISTS (SELECT 1 FROM outbox_messages WHERE transaction_id = t.id AND event_type = 'WalletBalanceChanged') THEN
    RAISE EXCEPTION 'wallet movement requires balance event' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER transaction_result AFTER INSERT OR UPDATE ON wager_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_transaction_result();

CREATE FUNCTION guard_outbox_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.transaction_id,NEW.aggregate_id,NEW.event_type,NEW.payload,NEW.occurred_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.transaction_id,OLD.aggregate_id,OLD.event_type,OLD.payload,OLD.occurred_at)
     OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'outbox event is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER outbox_update BEFORE UPDATE ON outbox_messages FOR EACH ROW EXECUTE FUNCTION guard_outbox_update();
CREATE TRIGGER outbox_no_delete BEFORE DELETE ON outbox_messages FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER outbox_no_truncate BEFORE TRUNCATE ON outbox_messages FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();

CREATE FUNCTION verify_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t wager_transactions%ROWTYPE; e wallet_ledger_entries%ROWTYPE; expected_status text;
BEGIN
  SELECT * INTO t FROM wager_transactions WHERE id = NEW.transaction_id;
  expected_status := CASE NEW.event_type WHEN 'WagerTransactionProcessed' THEN 'PROCESSED'
    WHEN 'WagerTransactionRejected' THEN 'REJECTED' WHEN 'WagerTransactionFailed' THEN 'FAILED'
    WHEN 'WagerTransactionPendingReference' THEN 'PENDING_REFERENCE' WHEN 'WalletBalanceChanged' THEN 'PROCESSED' ELSE NULL END;
  IF t.id IS NULL OR t.wallet_id <> NEW.aggregate_id OR expected_status IS NULL OR t.status <> expected_status THEN
    RAISE EXCEPTION 'outbox event does not match its transaction' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'WalletBalanceChanged' THEN
    SELECT * INTO e FROM wallet_ledger_entries WHERE transaction_id = t.id;
    IF NOT FOUND OR (NEW.payload#>>'{data,walletVersion}') IS DISTINCT FROM e.wallet_version::text
      OR (NEW.payload#>>'{data,direction}') IS DISTINCT FROM e.direction
      OR (NEW.payload#>>'{data,money,amount}') IS DISTINCT FROM e.amount::text
      OR (NEW.payload#>>'{data,money,currency}') IS DISTINCT FROM e.currency
      OR (NEW.payload#>>'{data,balanceBefore,amount}') IS DISTINCT FROM e.balance_before::text
      OR (NEW.payload#>>'{data,balanceAfter,amount}') IS DISTINCT FROM e.balance_after::text THEN
      RAISE EXCEPTION 'balance event requires matching ledger' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER outbox_insert BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION verify_outbox_insert();

CREATE FUNCTION guard_inbox_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.consumer_name,NEW.message_id,NEW.payload_hash,NEW.received_at)
      IS DISTINCT FROM ROW(OLD.consumer_name,OLD.message_id,OLD.payload_hash,OLD.received_at)
    OR (OLD.processed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'committed inbox identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER inbox_update BEFORE UPDATE ON inbox_messages FOR EACH ROW EXECUTE FUNCTION guard_inbox_update();
CREATE TRIGGER inbox_no_delete BEFORE DELETE ON inbox_messages FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER inbox_no_truncate BEFORE TRUNCATE ON inbox_messages FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jungle_app') THEN
    GRANT USAGE ON SCHEMA public TO jungle_app;
    GRANT SELECT, INSERT, UPDATE ON wallets,wager_transactions,inbox_messages,outbox_messages TO jungle_app;
    GRANT SELECT, INSERT ON wallet_ledger_entries,failed_messages TO jungle_app;
  END IF;
END; $$;
`;

export const schemaDown = String.raw`
DROP TABLE IF EXISTS failed_messages, outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE;
DROP FUNCTION IF EXISTS guard_inbox_update(), verify_outbox_insert(), guard_outbox_update(), verify_transaction_result(), guard_transaction_update(), verify_ledger_insert(), verify_wallet_movement(), guard_wallet_update(), forbid_audit_mutation() CASCADE;
`;
