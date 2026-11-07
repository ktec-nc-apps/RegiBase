<?php
/**
 * What every test here starts from: Nextcloud's own classes, read from disk (no
 * database, no config.php, no network), RegiBase's classes, and a few helpers.
 *
 *   NC_ROOT       the Nextcloud to borrow classes from (default /var/www/nextcloud)
 *   REGIBASE_LIB  the lib/ folder under test (default this app's own); pointing it
 *                 at a copy of an older lib/ is how a test is shown to fail there
 *
 * Each test prints PASS/FAIL lines and ends with "ALL PASS" or "N FAILED".
 */
declare(strict_types=1);

$nc = getenv('NC_ROOT') ?: '/var/www/nextcloud';
require $nc . '/3rdparty/autoload.php';
require $nc . '/lib/composer/autoload.php';
define('RB_LIB', rtrim(getenv('REGIBASE_LIB') ?: __DIR__ . '/../lib', '/'));
define('RB_NC', $nc);
spl_autoload_register(static function (string $class): void {
	$prefix = 'OCA\\RegiBase\\';
	if (str_starts_with($class, $prefix)) {
		$file = RB_LIB . '/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
		if (is_file($file)) {
			require $file;
		}
	}
});
// Guzzle warns about options it will drop in its next major version; not our concern here.
set_error_handler(static fn (int $no) => $no === E_USER_DEPRECATED || $no === E_DEPRECATED, E_USER_DEPRECATED | E_DEPRECATED);

$GLOBALS['rb_fail'] = 0;

function check(string $name, bool $ok, string $got = ''): void {
	echo ($ok ? 'PASS' : 'FAIL') . '  ' . $name . ($ok || $got === '' ? '' : '  (' . $got . ')') . "\n";
	if (!$ok) {
		$GLOBALS['rb_fail']++;
	}
}

function finish(): never {
	$n = $GLOBALS['rb_fail'];
	echo $n === 0 ? "\nALL PASS\n" : "\n$n FAILED\n";
	exit($n === 0 ? 0 : 1);
}

/** Run $fn; a crash in it is a failure of the test named, not the end of the run. */
function attempt(string $name, callable $fn): mixed {
	try {
		return $fn();
	} catch (\Throwable $e) {
		check($name, false, get_class($e) . ': ' . $e->getMessage());
		return null;
	}
}

/**
 * An object of $class built without its constructor, with whichever of $props
 * the class has. The same test can so build the class before and after a change
 * to what it is made of.
 */
function build(string $class, array $props = []): object {
	$rc = new ReflectionClass($class);
	$obj = $rc->newInstanceWithoutConstructor();
	foreach ($props as $name => $value) {
		for ($c = $rc; $c !== false; $c = $c->getParentClass()) {
			if ($c->hasProperty($name)) {
				$c->getProperty($name)->setValue($obj, $value);
				break;
			}
		}
	}
	return $obj;
}

/** Set a property that may be private to a parent class. */
function poke(object $obj, string $name, mixed $value): void {
	for ($c = new ReflectionClass($obj); $c !== false; $c = $c->getParentClass()) {
		if ($c->hasProperty($name)) {
			$c->getProperty($name)->setValue($obj, $value);
			return;
		}
	}
}

/** An object implementing $iface whose methods return empty defaults, except those in $over. */
function stub(string $iface, array $over = []): object {
	static $n = 0;
	$n++;
	$r = new ReflectionClass($iface);
	$cls = 'RbStub' . $n;
	$code = ($r->isInterface() ? "class $cls implements \\$iface" : "class $cls extends \\$iface") . ' { public array $__o = []; ';
	foreach ($r->getMethods() as $m) {
		if (!$m->isAbstract() && !$r->isInterface()) {
			continue;
		}
		$params = [];
		foreach ($m->getParameters() as $p) {
			$s = '';
			if ($p->hasType()) {
				$s .= stubType($p->getType()) . ' ';
			}
			if ($p->isPassedByReference()) {
				$s .= '&';
			}
			if ($p->isVariadic()) {
				$s .= '...';
			}
			$s .= '$' . $p->getName();
			if ($p->isDefaultValueAvailable()) {
				$s .= ' = ' . var_export($p->getDefaultValue(), true);
			} elseif ($p->isOptional() && !$p->isVariadic()) {
				$s .= ' = null';
			}
			$params[] = $s;
		}
		$name = $m->getName();
		$rt = $m->hasReturnType() ? (string)$m->getReturnType() : '';
		$call = "(\$this->__o['$name'])(...func_get_args())";
		if ($rt === 'void') {
			$body = "if (isset(\$this->__o['$name'])) { $call; } return;";
		} elseif ($rt === 'never') {
			$body = "if (isset(\$this->__o['$name'])) { $call; } throw new \\LogicException('never');";
		} else {
			$body = "if (isset(\$this->__o['$name'])) { return $call; }";
			$body .= match (true) {
				$rt === 'bool' => ' return false;',
				$rt === 'string' => " return '';",
				$rt === 'int' => ' return 0;',
				$rt === 'float' => ' return 0.0;',
				$rt === 'array' => ' return [];',
				$rt === 'static' || $rt === 'self' => ' return $this;',
				$rt !== '' && $rt[0] !== '?' && !str_contains($rt, 'null') && $rt !== 'mixed' => " throw new \\LogicException('stub: $name');",
				default => ' return null;',
			};
		}
		if ($m->isStatic()) {
			$body = "throw new \\LogicException('static stub');";
		}
		$ret = $m->hasReturnType() ? ': ' . stubType($m->getReturnType()) : '';
		$code .= 'public ' . ($m->isStatic() ? 'static ' : '') . "function $name(" . implode(', ', $params) . ")$ret { $body } ";
	}
	$code .= '}';
	eval($code);
	$o = new $cls();
	$o->__o = $over;
	return $o;
}

function stubType(ReflectionType $t): string {
	if ($t instanceof ReflectionNamedType) {
		$name = $t->getName();
		$q = ($t->allowsNull() && $name !== 'mixed' && $name !== 'null') ? '?' : '';
		return $q . ($t->isBuiltin() || $name === 'static' || $name === 'self' ? $name : '\\' . $name);
	}
	if ($t instanceof ReflectionUnionType) {
		return implode('|', array_map(static fn ($x) => $x instanceof ReflectionNamedType
			? ($x->isBuiltin() ? $x->getName() : '\\' . $x->getName())
			: '(' . stubType($x) . ')', $t->getTypes()));
	}
	if ($t instanceof ReflectionIntersectionType) {
		return implode('&', array_map(static fn ($x) => '\\' . $x->getName(), $t->getTypes()));
	}
	return (string)$t;
}

/** A request whose parameters are $params. */
function request(array $params): object {
	return stub(OCP\IRequest::class, ['getParam' => static fn ($k, $d = null) => $params[$k] ?? $d]);
}

/** An ApiController for $uid, built from whichever of $props it is made of. */
function apiController(string $uid, array $props, array $params = []): OCA\RegiBase\Controller\ApiController {
	$user = stub(OCP\IUser::class, ['getUID' => static fn () => $uid]);
	$props['userSession'] = stub(OCP\IUserSession::class, ['getUser' => static fn () => $user]);
	$api = build(OCA\RegiBase\Controller\ApiController::class, $props);
	(new ReflectionProperty(OCP\AppFramework\Controller::class, 'request'))->setValue($api, request($params));
	return $api;
}

/** A user as Nextcloud hands one out. */
function user(string $uid, string $name = '', string $email = ''): object {
	return stub(OCP\IUser::class, [
		'getUID' => static fn () => $uid,
		'getDisplayName' => static fn () => $name !== '' ? $name : $uid,
		'isEnabled' => static fn () => true,
		'getSystemEMailAddress' => static fn () => $email !== '' ? $email : null,
		'getEMailAddress' => static fn () => $email !== '' ? $email : null,
	]);
}

/** An in-memory distributed cache that can also do what IMemcache adds. */
function memcache(array &$store): object {
	return stub(OCP\IMemcache::class, [
		'get' => static function ($k) use (&$store) { return $store[$k] ?? null; },
		'set' => static function ($k, $v, $ttl = 0) use (&$store) { $store[$k] = $v; return true; },
		'hasKey' => static function ($k) use (&$store) { return isset($store[$k]); },
		'remove' => static function ($k) use (&$store) { unset($store[$k]); return true; },
		'add' => static function ($k, $v, $ttl = 0) use (&$store) {
			if (isset($store[$k])) {
				return false;
			}
			$store[$k] = $v;
			return true;
		},
	]);
}
