<?php
/**
 * Regression test: a collection duplicated with its records keeps its own key, so the
 * secret values copied with them can still be opened (review).
 *
 * Run: php tests/duplicate_key_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/memdb.php';

attempt('duplicate of a collection under its own key', function (): void {
	$w = world();
	$a = $w->coll('alice', 'Shared', [['key' => 'name', 'is_title' => true], ['key' => 'pw', 'secret' => true]], ['KeyWrap' => 'rbenc1:WRAPPED-DEK']);
	$w->record($a, ['name' => 'x', 'pw' => 'rbenc1:CIPHER']);
	$copy = $w->svc->duplicateCollection('alice', $a, true);
	$ce = $w->colls->get((int)$copy['id']);
	check('the copy has the records', count($w->recs->where(fn ($r) => (int)$r->getCollectionId() === (int)$copy['id'])) === 1);
	check('the copy keeps the key its secret values are under', ($ce->getKeyWrap() ?? '') === 'rbenc1:WRAPPED-DEK', var_export($ce->getKeyWrap(), true));
	$b = $w->coll('alice', 'Plain', [['key' => 'name', 'is_title' => true]]);
	$copy2 = $w->svc->duplicateCollection('alice', $b, true);
	check('a collection with no key of its own gives a copy with none', $w->colls->get((int)$copy2['id'])->getKeyWrap() === null);
});

finish();
