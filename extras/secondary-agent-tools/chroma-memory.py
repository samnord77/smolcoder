"""
chroma-memory.py — Moteur de Mémoire Vectorielle Infinie pour Smolcoder
Base de données vectorielle locale ChromaDB avec embeddings locaux Ollama (all-minilm).
100% Hors-ligne, Gratuit, Illimité, Zéro abonnement.
"""

import json
import os
import sys
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

site_pkgs = "C:/Python314/Lib/site-packages"
if os.path.exists(site_pkgs) and site_pkgs not in sys.path:
    sys.path.insert(0, site_pkgs)

import chromadb  # noqa: E402
from chromadb.api.types import Documents, EmbeddingFunction, Embeddings  # noqa: E402

CHROMA_PATH = "C:/Users/DELL/.smolcoder/chroma_db"
OLLAMA_EMBED_URL = "http://127.0.0.1:11434/api/embeddings"
EMBED_MODEL = "all-minilm"


class LocalOllamaEmbeddingFunction(EmbeddingFunction):
    def __init__(self, **kwargs):
        pass

    def __call__(self, input: Documents) -> Embeddings:
        embeddings = []
        for text in input:
            req_data = json.dumps({"model": EMBED_MODEL, "prompt": text}).encode("utf-8")
            req = urllib.request.Request(OLLAMA_EMBED_URL, data=req_data, headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=3) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    embeddings.append(data.get("embedding", []))
            except Exception:
                # Vecteur zéro de secours (384 dimensions)
                embeddings.append([0.0] * 384)
        return embeddings

def get_collection():
    client = chromadb.PersistentClient(path=CHROMA_PATH)
    embed_fn = LocalOllamaEmbeddingFunction()
    return client.get_or_create_collection(name="smolcoder_infinite_memory", embedding_function=embed_fn)

def store_memory(mem_id: str, text: str, category: str = "general"):
    coll = get_collection()
    coll.upsert(
        ids=[mem_id],
        documents=[text],
        metadatas=[{"category": category}]
    )
    print(f"[ChromaDB] Souvenir enregistre avec succes (ID: {mem_id}, Categorie: {category})")

def recall_memory(query: str, n_results: int = 3):
    coll = get_collection()
    total = coll.count()
    if total == 0:
        print("[ChromaDB] La mémoire est actuellement vide.")
        return

    n = min(n_results, total)
    results = coll.query(query_texts=[query], n_results=n)

    docs = results.get("documents") if results else None
    if not docs or not docs[0]:
        print(f"[ChromaDB] Aucun souvenir trouvé pour '{query}'.")
        return

    ids = results.get("ids") if results else None
    metas = results.get("metadatas") if results else None

    first_docs = docs[0]
    first_ids = ids[0] if ids and len(ids) > 0 else []
    first_metas = metas[0] if metas and len(metas) > 0 else []

    print(f"\n[ChromaDB] {len(first_docs)} souvenirs pertinents trouvés pour '{query}' :")
    for i, doc in enumerate(first_docs):
        doc_id = first_ids[i] if i < len(first_ids) else f"mem_{i}"
        meta = first_metas[i] if i < len(first_metas) and isinstance(first_metas[i], dict) else {}
        cat = meta.get("category", "n/a") if isinstance(meta, dict) else "n/a"
        print(f"\n--- Souvenir #{i+1} [ID: {doc_id} | Catégorie: {cat}] ---")
        print(doc)

def stats_memory():
    coll = get_collection()
    print(f"[ChromaDB] Nombre total de souvenirs vectorisés : {coll.count()}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python chroma-memory.py <store|recall|stats> [arguments...]")
        sys.exit(0)

    action = sys.argv[1].lower()
    if action == "store" and len(sys.argv) >= 4:
        mem_id = sys.argv[2]
        text = sys.argv[3]
        cat = sys.argv[4] if len(sys.argv) > 4 else "general"
        store_memory(mem_id, text, cat)
    elif action == "recall" and len(sys.argv) >= 3:
        query = sys.argv[2]
        n = int(sys.argv[3]) if len(sys.argv) > 3 else 3
        recall_memory(query, n)
    elif action == "stats":
        stats_memory()
    else:
        print("Commande invalide.")
