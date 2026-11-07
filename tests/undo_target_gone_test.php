<?php
/**
 * Regression test: an undo never puts records back into a collection that is gone (review).
 *
 *   - records moved from A to B, then A deleted: undoing the move in B is refused, the
 *     copies stay in B, and no record is left under A's old id (where nothing shows it);
 *   - a record deleted in A, then A deleted and its deletion undone (A comes back under a
 *     new id): undoing the record's deletion is refused and said so, not counted as done.
 *
 * Run: php tests/undo_target_gone_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/memdb.php';

attempt('move undone after its source was deleted: the source comes back first', function (): void {
	$w = world();
	$a = $w->coll('alice', 'A', [['key' => 'name', 'is_title' => true]]);
	$b = $w->coll('alice', 'B', [['key' => 'name', 'is_title' => true]]);
	$r1 = $w->record($a, ['name' => 'Tanaka']);
	$w->svc->transferRecords('alice', ['sourceCollectionId' => $a, 'targetCollectionId' => $b, 'mode' => 'move',
		'recordIds' => [$r1], 'mapping' => ['name' => 'name']]);
	$w->svc->deleteCollection('alice', $a);
	$res = $w->svc->undo('alice', $b);
	$na = (int)($res['recovered'][0]['id'] ?? 0);
	check('A was brought back', ($res['recovered'][0]['how'] ?? '') === 'restored' && ($res['recovered'][0]['name'] ?? '') === 'A', json_encode($res));
	check('the record is back in A', count($w->recs->where(fn ($r) => (int)$r->getCollectionId() === $na)) === 1);
	check('and gone from B', count($w->recs->where(fn ($r) => (int)$r->getCollectionId() === $b)) === 0);
	check('no record left under a collection that is gone', $w->orphans() === 0, 'orphans=' . $w->orphans());
	check('reported as undone', ($res['undone'] ?? 0) >= 1 && ($res['refused'] ?? 0) === 0, json_encode($res));
});

attempt('move undone after its source was deleted and its deletion is no longer in the history', function (): void {
	$w = world();
	$a = $w->coll('alice', 'A', [['key' => 'name', 'is_title' => true], ['key' => 'tel']]);
	$b = $w->coll('alice', 'B', [['key' => 'name', 'is_title' => true], ['key' => 'tel']]);
	$r1 = $w->record($a, ['name' => 'Ueda', 'tel' => '03-1234']);
	$w->svc->transferRecords('alice', ['sourceCollectionId' => $a, 'targetCollectionId' => $b, 'mode' => 'move',
		'recordIds' => [$r1], 'mapping' => ['name' => 'name', 'tel' => 'tel']]);
	$w->svc->deleteCollection('alice', $a);
	$hs = $w->history->listEntitiesForUser('alice', null);
	foreach ($hs as $h) {
		if (($w->history->decode($h)['kind'] ?? '') === 'recreate_collection') {
			$w->history->markUndone($h);   // as if the deletion had left the history
		}
	}
	$res = $w->svc->undo('alice', $b);
	check('asks before making a new collection', ($res['can_create'] ?? false) === true && ($res['refused_reason'] ?? '') === 'target_gone', json_encode($res));
	check('nothing changed yet: the record is still in B', count($w->recs->where(fn ($r) => (int)$r->getCollectionId() === $b)) === 1);
	$res = $w->svc->undo('alice', $b, true);
	$nc = (int)($res['recovered'][0]['id'] ?? 0);
	check('a new collection was made', ($res['recovered'][0]['how'] ?? '') === 'created' && $nc > 0, json_encode($res));
	$in = $w->recs->where(fn ($r) => (int)$r->getCollectionId() === $nc);
	$d = $in ? json_decode(array_values($in)[0]->getData(), true) : [];
	check('the record is in it with its values', count($in) === 1 && ($d['name'] ?? '') === 'Ueda' && ($d['tel'] ?? '') === '03-1234', json_encode($d));
	$keys = array_values(array_map(fn ($f) => $f->getFieldKey(), $w->fields->where(fn ($f) => (int)$f->getCollectionId() === $nc)));
	sort($keys);
	check('with a field for each value', $keys === ['name', 'tel'], json_encode($keys));
	check('and gone from B', count($w->recs->where(fn ($r) => (int)$r->getCollectionId() === $b)) === 0);
	check('no record left under a collection that is gone', $w->orphans() === 0, 'orphans=' . $w->orphans());
});

attempt('record deletion undone after its collection came back under a new id', function (): void {
	$w = world();
	$a = $w->coll('alice', 'A', [['key' => 'name', 'is_title' => true]]);
	$r1 = $w->record($a, ['name' => 'Sato']);
	$w->record($a, ['name' => 'Suzuki']);
	$w->svc->deleteRecord('alice', $r1);
	$w->svc->deleteCollection('alice', $a);
	$back = $w->svc->undo('alice', null);   // the collection comes back (new id)
	$na = (int)($back['collection_id'] ?? 0);
	check('the collection came back under a new id', $na > 0 && $na !== $a, json_encode($back));
	$res = $w->svc->undo('alice', $na);   // the record's deletion: goes back into the collection brought back
	$names = array_map(fn ($r) => json_decode($r->getData(), true)['name'] ?? '', $w->recs->where(fn ($r) => (int)$r->getCollectionId() === $na));
	sort($names);
	check('the deleted record is back in the collection brought back', $names === ['Sato', 'Suzuki'], json_encode($names));
	check('no record left under a collection that is gone', $w->orphans() === 0, 'orphans=' . $w->orphans());
	check('reported as undone', ($res['undone'] ?? 0) === 1 && ($res['refused'] ?? 0) === 0, json_encode($res));
});

attempt('an edit undone after its collection came back under a new id', function (): void {
	$w = world();
	$a = $w->coll('alice', 'A', [['key' => 'name', 'is_title' => true]]);
	$r1 = $w->record($a, ['name' => 'Kato']);
	$w->svc->updateRecord('alice', $r1, ['name' => 'Kato Taro']);
	$w->svc->deleteCollection('alice', $a);
	$back = $w->svc->undo('alice', null);
	$na = (int)($back['collection_id'] ?? 0);
	$res = $w->svc->undo('alice', $na);   // the edit: made on the record under its old id
	$names = array_map(fn ($r) => json_decode($r->getData(), true)['name'] ?? '', $w->recs->where(fn ($r) => (int)$r->getCollectionId() === $na));
	check('the edit is undone on the record brought back', $names === ['Kato'], json_encode($names));
	check('reported as undone', ($res['undone'] ?? 0) === 1, json_encode($res));
});

attempt('reverting to a snapshot brings the deleted source back', function (): void {
	$w = world();
	$a = $w->coll('alice', 'A', [['key' => 'name', 'is_title' => true]]);
	$b = $w->coll('alice', 'B', [['key' => 'name', 'is_title' => true]]);
	$r1 = $w->record($a, ['name' => 'Mori']);
	$w->svc->transferRecords('alice', ['sourceCollectionId' => $a, 'targetCollectionId' => $b, 'mode' => 'move',
		'recordIds' => [$r1], 'mapping' => ['name' => 'name']]);
	$w->svc->deleteCollection('alice', $a);
	$h = $w->svc->history('alice', $b);
	$first = (int)end($h)['id'];
	$res = $w->svc->undoDownTo('alice', $b, $first);
	check('the source came back and nothing was refused', ($res['refused'] ?? 0) === 0 && count($w->recs->where(fn ($r) => (int)$r->getCollectionId() === $b)) === 0, json_encode($res));
	check('no record left under a collection that is gone', $w->orphans() === 0, 'orphans=' . $w->orphans());
});

attempt('move undone while its source is still there (unchanged)', function (): void {
	$w = world();
	$a = $w->coll('alice', 'A', [['key' => 'name', 'is_title' => true]]);
	$b = $w->coll('alice', 'B', [['key' => 'name', 'is_title' => true]]);
	$r1 = $w->record($a, ['name' => 'Ito']);
	$w->svc->transferRecords('alice', ['sourceCollectionId' => $a, 'targetCollectionId' => $b, 'mode' => 'move',
		'recordIds' => [$r1], 'mapping' => ['name' => 'name']]);
	$res = $w->svc->undo('alice', $b);
	check('the record is back in A', count($w->recs->where(fn ($r) => (int)$r->getCollectionId() === $a)) === 1);
	check('and gone from B', count($w->recs->where(fn ($r) => (int)$r->getCollectionId() === $b)) === 0);
	check('reported as undone', ($res['undone'] ?? 0) >= 1 && ($res['refused'] ?? 0) === 0, json_encode($res));
});

finish();
