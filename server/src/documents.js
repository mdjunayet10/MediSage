export class DocumentStore {
  constructor({ ttlMs, maxDocuments = 20, now = () => Date.now(), onDelete = () => {} }) {
    this.ttlMs = ttlMs;
    this.maxDocuments = maxDocuments;
    this.now = now;
    this.onDelete = onDelete;
    this.documents = new Map();
  }

  set(document) {
    const timestamp = this.now();
    this.documents.set(document.id, {
      ...document,
      createdAt: timestamp,
      expiresAt: timestamp + this.ttlMs,
    });
    this.cleanup();
    return this.documents.get(document.id);
  }

  update(id, patch) {
    const document = this.get(id, { refresh: false });
    if (!document) return null;
    Object.assign(document, typeof patch === "function" ? patch(document) : patch);
    return document;
  }

  get(id, { refresh = true, ownerId } = {}) {
    if (!id) return null;
    const document = this.documents.get(id);
    if (!document) return null;
    if (ownerId && document.ownerId !== ownerId) return null;
    if (document.expiresAt <= this.now()) {
      this.documents.delete(id);
      this.onDelete(document);
      return null;
    }
    if (refresh) document.expiresAt = this.now() + this.ttlMs;
    return document;
  }

  delete(id, { ownerId } = {}) {
    const document = this.get(id, { refresh: false });
    if (!document || (ownerId && document.ownerId !== ownerId)) return false;
    const deleted = this.documents.delete(id);
    if (deleted) this.onDelete(document);
    return deleted;
  }

  has(id) {
    return Boolean(this.get(id, { refresh: false }));
  }

  countForOwner(ownerId) {
    this.cleanup();
    return [...this.documents.values()].filter(
      (document) => document.ownerId === ownerId,
    ).length;
  }

  cleanup() {
    for (const [id, document] of this.documents) {
      if (document.expiresAt <= this.now()) {
        this.documents.delete(id);
        this.onDelete(document);
      }
    }
    if (this.documents.size > this.maxDocuments) {
      const oldest = [...this.documents.values()].sort(
        (a, b) => a.createdAt - b.createdAt,
      );
      for (const document of oldest.slice(
        0,
        this.documents.size - this.maxDocuments,
      )) {
        this.documents.delete(document.id);
        this.onDelete(document);
      }
    }
  }
}
