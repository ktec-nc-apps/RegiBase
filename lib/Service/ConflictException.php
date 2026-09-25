<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

/** The record was saved by somebody else after this edit started (review J18). */
class ConflictException extends \RuntimeException {
}
