<?php

declare(strict_types=1);

namespace OCA\RegiBase\Command;

use Symfony\Component\Console\Helper\Table;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

class FindRecords extends Base {
	protected function configure(): void {
		$this->setName('regibase:find')
			->setDescription('Search records of a collection by field value (case-insensitive, or --regex)')
			->addArgument('collection', InputArgument::REQUIRED, 'Collection id or name')
			->addArgument('query', InputArgument::REQUIRED, 'Text to look for (a PCRE pattern with --regex)')
			->addOption('regex', null, InputOption::VALUE_NONE, 'Treat the query as a regular expression (PCRE, case-sensitive)')
			->addUserOption()
			->addRevealOptions();
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$c = $this->resolveCollection($input);
		$key = $this->secretKey($c->getUserId(), $input, $output);
		$rawQuery = (string)$input->getArgument('query');
		$regex = (bool)$input->getOption('regex');
		$re = null;
		if ($regex) {
			$re = '~' . str_replace('~', '\\~', $rawQuery) . '~u';
			if (@preg_match($re, '') === false) {
				$output->writeln('<error>Invalid regular expression.</error>');
				return 1;
			}
		}
		$query = mb_strtolower($rawQuery);
		$match = function (string $val) use ($regex, $re, $query): bool {
			return $regex ? (bool)preg_match($re, $val) : (mb_strpos(mb_strtolower($val), $query) !== false);
		};

		$fields = $this->fields->findForCollection((int)$c->getId());
		$fieldsByKey = [];
		foreach ($fields as $f) {
			$fieldsByKey[$f->getFieldKey()] = $f;
		}

		$table = new Table($output);
		$table->setHeaders(['ID', 'Title', 'Matched field', 'Value']);
		$hits = 0;
		foreach ($this->records->findForCollection((int)$c->getId()) as $r) {
			$data = json_decode($r->getData() ?: '{}', true) ?: [];
			foreach ($fields as $f) {
				// Secret fields are only searchable once revealed.
				if ($f->getSecret() && $key === null) {
					continue;
				}
				$val = $this->reveal($key, $data[$f->getFieldKey()] ?? '');
				if ($val !== null && $val !== '' && $match($val)) {
					$table->addRow([
						$r->getId(),
						$this->titleOf($fieldsByKey, $data, $key),
						$f->getLabel(),
						$val,
					]);
					$hits++;
					break; // one row per record
				}
			}
		}
		if ($hits === 0) {
			$output->writeln('<comment>No matching records.</comment>');
			return 0;
		}
		$table->render();
		return 0;
	}
}
