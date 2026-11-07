<?php
/**
 * RegiBaseService over in-memory tables: each mapper is the real class with the
 * methods the service calls answered from an array (no database). The journal, the
 * record versions and the Files side (ImageService) are quiet stand-ins that write
 * down what they were asked to do.
 *
 *   $w = world();              tables + the service for one signed-in session
 *   $w->svc                    OCA\RegiBase\Service\RegiBaseService
 *   $w->coll('alice', [...])   a collection (fields: [['key'=>..,'type'=>..,'secret'=>..]])
 *   $w->record($cid, [...])    a record
 *   $w->share($cid, ...)       a share
 */
declare(strict_types=1);

use OCA\RegiBase\Db\CollectionEntity;
use OCA\RegiBase\Db\CollectionMapper;
use OCA\RegiBase\Db\FieldEntity;
use OCA\RegiBase\Db\FieldMapper;
use OCA\RegiBase\Db\HistoryEntity;
use OCA\RegiBase\Db\HistoryMapper;
use OCA\RegiBase\Db\RecordEntity;
use OCA\RegiBase\Db\RecordMapper;
use OCA\RegiBase\Db\ShareEntity;
use OCA\RegiBase\Db\ShareMapper;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\Entity;

// \OCP\Server::get() asks \OC::$server (lib/base.php, which starts all of Nextcloud and is
// not read here). A stand-in that hands out an empty IConfig is enough for the share dates.
if (!class_exists('OC', false)) {
	eval('class OC { public static $server; }');
}
\OC::$server = new class {
	private array $made = [];
	public function get(string $name) {
		return $this->made[$name] ??= ($name === OCP\IConfig::class
			? stub($name, [
				'getUserValue' => static fn ($u, $app, $k, $d = '') => $d,
				'getSystemValueString' => static fn ($k, $d = '') => $d,
			])
			: stub($name));
	}
};

final class MemTable {
	/** @var array<int,Entity> */
	public array $rows = [];
	private int $next = 1;
	public function __construct(int $start = 1) {
		$this->next = $start;
	}
	public function insert(Entity $e): Entity {
		$e->setId($this->next++);
		$this->rows[(int)$e->getId()] = $e;
		return $e;
	}
	public function update(Entity $e): Entity {
		$this->rows[(int)$e->getId()] = $e;
		return $e;
	}
	public function delete(Entity $e): Entity {
		unset($this->rows[(int)$e->getId()]);
		return $e;
	}
	public function get(int $id): Entity {
		if (!isset($this->rows[$id])) {
			throw new DoesNotExistException('row ' . $id);
		}
		return $this->rows[$id];
	}
	public function where(callable $f): array {
		return array_values(array_filter($this->rows, $f));
	}
}

class MemCollections extends CollectionMapper {
	public MemTable $t;
	public function insert(Entity $entity): Entity { return $this->t->insert($entity); }
	public function update(Entity $entity): Entity { return $this->t->update($entity); }
	public function delete(Entity $entity): Entity { return $this->t->delete($entity); }
	public function findAllForUser(string $userId): array { return $this->t->where(fn ($c) => $c->getUserId() === $userId); }
	public function findById(int $id): CollectionEntity { return $this->t->get($id); }
	public function findForUser(int $id, string $userId): CollectionEntity {
		$c = $this->t->get($id);
		if ($c->getUserId() !== $userId) {
			throw new DoesNotExistException('not yours');
		}
		return $c;
	}
	public function maxSort(string $userId): int { return 0; }
}

class MemFields extends FieldMapper {
	public MemTable $t;
	public function insert(Entity $entity): Entity { return $this->t->insert($entity); }
	public function findForCollection(int $collectionId): array { return $this->t->where(fn ($f) => (int)$f->getCollectionId() === $collectionId); }
	public function deleteForCollection(int $collectionId): void {
		foreach ($this->findForCollection($collectionId) as $f) {
			$this->t->delete($f);
		}
	}
}

class MemRecords extends RecordMapper {
	public MemTable $t;
	public function insert(Entity $entity): Entity { return $this->t->insert($entity); }
	public function update(Entity $entity): Entity { return $this->t->update($entity); }
	public function delete(Entity $entity): Entity { return $this->t->delete($entity); }
	public function find(int $id): RecordEntity { return $this->t->get($id); }
	public function findForCollection(int $collectionId): array { return $this->t->where(fn ($r) => (int)$r->getCollectionId() === $collectionId); }
	public function maxSort(int $collectionId): int { return count($this->findForCollection($collectionId)); }
	public function countForCollection(int $collectionId): int { return count($this->findForCollection($collectionId)); }
	public function updateIfUnchanged(RecordEntity $r, string $base): int { $this->t->update($r); return 1; }
	public function deleteForCollection(int $collectionId): void {
		foreach ($this->findForCollection($collectionId) as $r) {
			$this->t->delete($r);
		}
	}
}

class MemShares extends ShareMapper {
	public MemTable $t;
	public function insert(Entity $entity): Entity { return $this->t->insert($entity); }
	public function update(Entity $entity): Entity { return $this->t->update($entity); }
	public function delete(Entity $entity): Entity { return $this->t->delete($entity); }
	private function reaches(ShareEntity $s, string $userId, array $groupIds): bool {
		return ($s->getRecipientType() === 'user' && $s->getRecipientUid() === $userId)
			|| ($s->getRecipientType() === 'group' && in_array($s->getRecipientUid(), $groupIds, true));
	}
	public function findForUserAccess(int $collectionId, string $userId, array $groupIds): array {
		return $this->t->where(fn ($s) => (int)$s->getCollectionId() === $collectionId && $this->reaches($s, $userId, $groupIds));
	}
	public function findAllForUserAccess(string $userId, array $groupIds): array {
		return $this->t->where(fn ($s) => $this->reaches($s, $userId, $groupIds));
	}
	public function findForCollection(int $collectionId): array { return $this->t->where(fn ($s) => (int)$s->getCollectionId() === $collectionId); }
	public function findOne(int $collectionId, string $recipientUid, string $recipientType = 'user'): ?ShareEntity {
		return $this->t->where(fn ($s) => (int)$s->getCollectionId() === $collectionId && $s->getRecipientUid() === $recipientUid && $s->getRecipientType() === $recipientType)[0] ?? null;
	}
	public function collectionIsShared(int $collectionId): bool { return $this->findForCollection($collectionId) !== []; }
	public function deleteForCollection(int $collectionId): void {
		foreach ($this->findForCollection($collectionId) as $s) {
			$this->t->delete($s);
		}
	}
}

class MemHistory extends HistoryMapper {
	public MemTable $t;
	public function insert(Entity $entity): Entity { return $this->t->insert($entity); }
	public function update(Entity $entity): Entity { return $this->t->update($entity); }
	private function active(string $userId): array {
		$rows = $this->t->where(fn ($h) => $h->getUserId() === $userId && !$h->getUndone());
		usort($rows, fn ($a, $b) => $b->getId() <=> $a->getId());
		return $rows;
	}
	public function listForUser(string $userId, int $limit = 200, ?int $collectionId = null): array {
		$rows = $this->t->where(fn ($h) => $h->getUserId() === $userId && ($collectionId === null || (int)$h->getCollectionId() === $collectionId));
		usort($rows, fn ($a, $b) => $b->getId() <=> $a->getId());
		return array_slice($rows, 0, $limit);
	}
	public function latestActive(string $userId, ?int $collectionId = null): ?HistoryEntity {
		foreach ($this->active($userId) as $h) {
			if ($collectionId === null || (int)$h->getCollectionId() === $collectionId) {
				return $h;
			}
		}
		return null;
	}
	public function activeGroup(string $userId, string $grp): array {
		return array_values(array_filter($this->active($userId), fn ($h) => $h->getGrp() === $grp));
	}
	public function deleteAllForUser(string $userId, ?int $collectionId = null): void {
		foreach ($this->t->where(fn ($h) => $h->getUserId() === $userId && ($collectionId === null || (int)$h->getCollectionId() === $collectionId)) as $h) {
			$this->t->delete($h);
		}
	}
	public function deleteForCollection(int $collectionId): void {
		foreach ($this->t->where(fn ($h) => (int)$h->getCollectionId() === $collectionId) as $h) {
			$this->t->delete($h);
		}
	}
	public function pruneToLimit(string $userId, int $keep): void {}
}

/** The journal of session versions: nothing kept. */
class QuietJournal extends OCA\RegiBase\Service\VersionJournal {
	public function suspend(bool $on): void {}
	public function before(array $row): void {}
	public function deleted(int $collectionId, int $recordId): void {}
	public function added(int $collectionId, int $recordId): void {}
	public function fieldsBefore(int $collectionId, array $fieldsJson): void {}
	public function listFor(int $collectionId): array { return []; }
	public function fromUp(int $collectionId, int $versionId): array { return []; }
	public function dropFromUp(int $collectionId, int $versionId): void {}
	public function renumber(int $collectionId, int $oldId, int $newId): void {}
	public function movedTo(int $collectionId, int $recordId, int $targetId): void {}
	public function heldData(int $collectionId): array { return []; }
	public function dropForCollections(array $collectionIds): void {}
}

/** Record versions: off. */
class QuietVersions extends OCA\RegiBase\Service\RecordVersionService {
	public function keep(string $userId): int { return 0; }
	public function when(string $userId): string { return 'auto'; }
	public function take(int $recordId, array $snapshot, int $keep): void {}
	public function list(int $recordId): array { return []; }
	public function read(int $recordId, int $number): array { return []; }
	public function drop(int $recordId): void {}
}

/** The Files side: held files per (user, folder), and a log of what went to the trash. */
class MemFiles extends OCA\RegiBase\Service\ImageService {
	public array $held = [];     // "uid|folder" => [fileId, ...]
	public array $trashed = [];  // ["uid|fileId"]
	public array $readable = []; // "uid|fileId" => true
	public function getBaseFolder(string $userId): string { return 'RegiBase'; }
	public function ensureFolderExists(string $userId, string $folderPath): void {}
	public function folderExists(string $userId, string $folderPath): bool { return false; }
	public function normalizePath(string $path): string { return trim($path, '/'); }
	public function heldIds(string $userId, string $folder): array { return $this->held[$userId . '|' . $folder] ?? []; }
	public function trashIfOwned(string $userId, string $id, string $folder): bool { $this->trashed[] = $userId . '|' . $id; return true; }
	public function holdIfOwned(string $userId, string $id, string $folder): bool { return false; }
	public function unholdIfHeld(string $userId, string $id, string $folder): bool { return false; }
	public function canRead(string $userId, string $id): bool { return isset($this->readable[$userId . '|' . $id]); }
	public function fileContentById(string $userId, string $id): ?array { return null; }
}

final class World {
	public MemTable $colls;
	public MemTable $fields;
	public MemTable $recs;
	public MemTable $shares;
	public MemTable $hist;
	public array $session = [];
	public array $groups = [];   // uid => [gid, ...]
	public MemFiles $files;
	public OCA\RegiBase\Service\HistoryService $history;
	public OCA\RegiBase\Service\RegiBaseService $svc;

	public function __construct() {
		$this->colls = new MemTable(1);
		$this->fields = new MemTable(1);
		$this->recs = new MemTable(100);
		$this->shares = new MemTable(1);
		$this->hist = new MemTable(1);
		$mk = function (string $cls, MemTable $t): object {
			$o = (new ReflectionClass($cls))->newInstanceWithoutConstructor();
			$o->t = $t;
			return $o;
		};
		$this->files = (new ReflectionClass(MemFiles::class))->newInstanceWithoutConstructor();
		$hm = $mk(MemHistory::class, $this->hist);
		$this->history = build(OCA\RegiBase\Service\HistoryService::class, [
			'mapper' => $hm,
			'config' => stub(OCP\IConfig::class),
		]);
		$self = $this;
		$session = stub(OCP\ISession::class, [
			'get' => static function ($k) use ($self) { return $self->session[$k] ?? null; },
			'set' => static function ($k, $v) use ($self) { $self->session[$k] = $v; },
		]);
		$l = stub(OCP\IL10N::class, ['t' => static fn ($s, $p = []) => vsprintf($s, (array)$p)]);
		$users = stub(OCP\IUserManager::class, ['get' => static fn ($uid) => user((string)$uid)]);
		$groups = stub(OCP\IGroupManager::class, ['getUserGroupIds' => static fn ($u) => $self->groups[$u->getUID()] ?? []]);
		$shareManager = stub(OCP\Share\IManager::class, [
			'shareApiEnabled' => static fn () => true,
			'sharingDisabledForUser' => static fn () => false,
			'allowGroupSharing' => static fn () => true,
			'shareWithGroupMembersOnly' => static fn () => false,
		]);
		$this->svc = build(OCA\RegiBase\Service\RegiBaseService::class, [
			'collections' => $mk(MemCollections::class, $this->colls),
			'fields' => $mk(MemFields::class, $this->fields),
			'records' => $mk(MemRecords::class, $this->recs),
			'shares' => $mk(MemShares::class, $this->shares),
			'images' => $this->files,
			'l' => $l,
			'session' => $session,
			'history' => $this->history,
			'versions' => (new ReflectionClass(QuietVersions::class))->newInstanceWithoutConstructor(),
			'userManager' => $users,
			'groupManager' => $groups,
			'shareManager' => $shareManager,
			'journal' => (new ReflectionClass(QuietJournal::class))->newInstanceWithoutConstructor(),
		]);
	}

	/** A collection of $uid with $fields ([['key','type'?,'secret'?,'is_title'?]]). */
	public function coll(string $uid, string $name, array $fields = [], array $set = []): int {
		$c = new CollectionEntity();
		$c->setUserId($uid);
		$c->setName($name);
		$c->setIcon('📁');
		$c->setColor('#000');
		$c->setDescription('');
		$c->setView('table');
		$c->setRecordSort('created_asc');
		$c->setLocked(false);
		$c->setKeyHead(false);
		$c->setKeySep('space');
		$c->setKeySepChar('');
		$c->setFilesFolder('RegiBase/' . $name);
		$c->setMapProvider('');
		$c->setSecret(false);
		$c->setSort(0);
		$c->setCreatedAt('2026-01-01T00:00:00Z');
		$c->setUpdatedAt('2026-01-01T00:00:00Z');
		foreach ($set as $k => $v) {
			$c->{'set' . $k}($v);
		}
		$this->colls->insert($c);
		$cid = (int)$c->getId();
		foreach ($fields as $i => $f) {
			$e = new FieldEntity();
			$e->setCollectionId($cid);
			$e->setFieldKey($f['key']);
			$e->setLabel($f['label'] ?? $f['key']);
			$e->setType($f['type'] ?? 'text');
			$e->setRequired(false);
			$e->setSecret(!empty($f['secret']));
			$e->setIsTitle(!empty($f['is_title']));
			$e->setListShow(true);
			$e->setTableShow(true);
			$e->setCardShow(true);
			$e->setSort($i);
			$e->setConcat(0);
			$e->setConcatSep('space');
			$e->setConcatSepChar('');
			$this->fields->insert($e);
		}
		return $cid;
	}

	/** A record in $cid, its reading made as the service makes it on a write. */
	public function record(int $cid, array $data, string $reading = ''): int {
		$r = new RecordEntity();
		$r->setCollectionId($cid);
		$r->setData(json_encode($data ?: new stdClass(), JSON_UNESCAPED_UNICODE));
		$r->setReading($reading);
		$r->setSort(count($this->recs->rows) + 1);
		$r->setCreatedAt('2026-01-01T00:00:00Z');
		$r->setUpdatedAt('2026-01-01T00:00:00.000Z');
		$this->recs->insert($r);
		return (int)$r->getId();
	}

	public function share(int $cid, string $owner, string $to, string $perm, string $type = 'user', ?string $encKey = null): void {
		$s = new ShareEntity();
		$s->setCollectionId($cid);
		$s->setOwnerUid($owner);
		$s->setRecipientUid($to);
		$s->setRecipientType($type);
		$s->setPerm($perm);
		$s->setEncKey($encKey);
		$s->setCreatedAt('2026-01-01T00:00:00Z');
		$this->shares->insert($s);
	}

	public function data(int $rid): array {
		return json_decode($this->recs->get($rid)->getData(), true) ?: [];
	}

	/** Records whose collection is not there: they show nowhere. */
	public function orphans(): int {
		return count($this->recs->where(fn ($r) => !isset($this->colls->rows[(int)$r->getCollectionId()])));
	}
}

function world(): World {
	return new World();
}
