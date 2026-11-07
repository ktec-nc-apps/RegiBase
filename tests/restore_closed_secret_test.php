<?php
/**
 * Regression test: a restore that would have to change hidden collections not opened in
 * this session is refused before anything is changed, and says why (review).
 *
 *   - overwrite with a hidden collection closed: refused up front, nothing deleted;
 *   - merge into a closed hidden collection of the same name: refused the same way;
 *   - merge with no name in common, or the hidden collection opened: not refused.
 *
 * Run: php tests/restore_closed_secret_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/memdb.php';

function closedWorld(): array {
	$w = world();
	$plain = $w->coll('alice', 'Plain', [['key' => 'name', 'is_title' => true]]);
	$hidden = $w->coll('alice', 'Hidden', [['key' => 'name', 'is_title' => true]], ['Secret' => true, 'SecretHash' => password_hash('123456', PASSWORD_DEFAULT)]);
	$w->record($plain, ['name' => 'a']);
	$w->record($hidden, ['name' => 'b']);
	return [$w, $plain, $hidden];
}

attempt('overwrite with a closed hidden collection', function (): void {
	[$w] = closedWorld();
	$err = null;
	try {
		$w->svc->importAll('alice', ['collections' => []], [], 'overwrite');
	} catch (\Throwable $e) {
		$err = $e;
	}
	check('refused with its own reason', $err !== null && str_ends_with(get_class($err), 'SecretCollectionsClosedException'), $err ? get_class($err) : 'no error');
	check('nothing was deleted first', count($w->colls->rows) === 2 && count($w->recs->rows) === 2, count($w->colls->rows) . ' collections');
	check('the page can be told before anything is written',
		method_exists($w->svc, 'closedSecretsInTheWay') && $w->svc->closedSecretsInTheWay('alice', ['collections' => []], 'overwrite') === ['Hidden']);
});

attempt('merge and the closed hidden collection', function (): void {
	[$w, , $hidden] = closedWorld();
	$m = fn (string $name) => method_exists($w->svc, 'closedSecretsInTheWay')
		? $w->svc->closedSecretsInTheWay('alice', ['collections' => [['name' => $name]]], 'merge') : null;
	check('a merge into it is refused', $m('Hidden') === ['Hidden'], json_encode($m('Hidden')));
	check('a merge with no name in common is not', $m('Other') === [], json_encode($m('Other')));
	check('an add never is', method_exists($w->svc, 'closedSecretsInTheWay')
		&& $w->svc->closedSecretsInTheWay('alice', ['collections' => [['name' => 'Hidden']]], 'add') === []);
	$w->session[OCA\RegiBase\Service\RegiBaseService::secretOpenKey($hidden)] = true;
	check('once opened with its key, not refused', $m('Hidden') === [], json_encode($m('Hidden')));
});

finish();
