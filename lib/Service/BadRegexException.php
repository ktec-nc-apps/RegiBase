<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

/** A search pattern that is not a valid regular expression, too long, or too costly to run. */
class BadRegexException extends \RuntimeException {
}
