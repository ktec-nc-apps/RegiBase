<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

/**
 * A restore refused before anything was changed: it would have to change hidden (secret)
 * collections whose 6-digit key was not given in this session.
 */
class SecretCollectionsClosedException extends \RuntimeException {
}
