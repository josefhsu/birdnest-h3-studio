"""Guard the transition from queued to running on the Colab VM."""
from contextlib import contextmanager
import fcntl
import json
import time


@contextmanager
def queue_lock(root):
    with (root / "queue.lock").open("a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        yield


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def write_queue(root, queue):
    path = root / "queue.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(queue), encoding="utf-8")
    temporary.replace(path)


def initialize(root, batch_id, ids):
    with queue_lock(root):
        write_queue(root, {"batch_id": batch_id, "ids": ids, "cancelled": []})


def read_queue(root, batch_id):
    queue = load_json(root / "queue.json")
    if queue.get("batch_id") != batch_id:
        raise RuntimeError("目前的排隊批次已變更")
    return queue


def cancel_pending(root, batch_id, ids):
    with queue_lock(root):
        queue = read_queue(root, batch_id)
        status = load_json(root / "status.json")
        jobs = status.get("jobs", {}) if status.get("queue_id") == batch_id else {}
        removed = set(queue["cancelled"])
        accepted, skipped = [], []
        for job_id in ids:
            if job_id in queue["ids"] and (job_id in removed or jobs.get(job_id, {}).get("status", "queued") == "queued"):
                accepted.append(job_id)
            else:
                skipped.append(job_id)
        queue["cancelled"] = sorted(removed.union(accepted))
        write_queue(root, queue)
        return {"removed": accepted, "skipped": skipped}


def start_job(root, batch_id, job_id, state, save):
    with queue_lock(root):
        cancelled = job_id in read_queue(root, batch_id)["cancelled"]
        if cancelled:
            state.update(status="cancelled")
        else:
            state.update(status="running", started=time.time())
        save()
        return not cancelled
