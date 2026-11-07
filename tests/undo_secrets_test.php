<?php
/**
 * Regression test: somebody a collection is shared with cannot undo their way into a
 * secret field they were not given (review).
 *
 * bob (edit, no key) edits a record; alice then changes its secret field; bob undoes
 * his edit. His own field goes back; alice's secret value stays.
 *
 * Run: php tests/undo_secrets_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/memdb.php';

attempt('undo by an editor without the key', function (): void {
	$w = world();
	$a = $w->coll('alice', 'Logins', [['key' => 'site', 'is_title' => true], ['key' => 'pw', 'secret' => true]]);
	$rid = $w->record($a, ['site' => 'old.example', 'pw' => 'first']);
	$w->share($a, 'alice', 'bob', 'edit');

	$w->svc->updateRecord('bob', $rid, ['site' => 'new.example']);
	check('bob\'s save left the secret as it was (as before)', ($w->data($rid)['pw'] ?? null) === 'first', json_encode($w->data($rid)));
	$w->svc->updateRecord('alice', $rid, ['site' => 'new.example', 'pw' => 'second']);
	$w->svc->undo('bob', $a);
	$d = $w->data($rid);
	check('bob\'s field went back', ($d['site'] ?? null) === 'old.example', json_encode($d));
	check('alice\'s newer secret stays', ($d['pw'] ?? null) === 'second', json_encode($d));
});

finish();
